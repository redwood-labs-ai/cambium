// RED-313: local HTTP server for `cambium inspect`. Plain node:http — no
// framework, no bundler, zero new dependencies. Serves a small JSON API over
// the runs/ directory plus an SSE channel that pushes when new runs land, and
// the static viewer assets from `public/`.
//
// Localhost-only by design (the ticket: no auth, no remote bind; share via
// SSH port-forward). The one untrusted input is the `:id` path segment and
// static asset paths — both pass through path-traversal guards before any
// filesystem access.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listRuns, loadRun } from './runs.js';

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url));
/** Bundled viewer assets ship next to this module (copied into dist/ at
 *  build). Overridable for tests / dev. */
export const DEFAULT_PUBLIC_DIR = join(MODULE_DIR, 'public');

export type RunInspectOptions = {
  /** Directory whose `<run-id>/trace.json` files are served. */
  runsDir: string;
  /** Bind host. Defaults to 127.0.0.1 — do not expose remotely. */
  host?: string;
  /** Port. 0 picks an ephemeral port (used by tests). Default 3210. */
  port?: number;
  /** Static asset dir. Defaults to the bundled `public/`. */
  publicDir?: string;
};

export type InspectHandle = {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

/** Resolve a request path to a file inside publicDir, or null if it escapes.
 *  `normalize` collapses `..`; we then require the result stay within the dir. */
function resolveAsset(publicDir: string, urlPath: string): string | null {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.(\/|\\|$))+/, '');
  const abs = join(publicDir, rel);
  if (abs !== publicDir && !abs.startsWith(publicDir + (process.platform === 'win32' ? '\\' : '/'))) {
    return null;
  }
  return abs;
}

export function runInspect(opts: RunInspectOptions): Promise<InspectHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 3210;
  const publicDir = opts.publicDir ?? DEFAULT_PUBLIC_DIR;
  const runsDir = opts.runsDir;

  // ── SSE clients + a debounced fs.watch on runsDir ────────────────────
  const sseClients = new Set<ServerResponse>();
  let watcher: FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  function broadcastRunsChanged(): void {
    for (const res of sseClients) {
      try {
        res.write('event: runs-changed\ndata: {}\n\n');
      } catch {
        /* client gone; reaped on 'close' */
      }
    }
  }
  function startWatch(): void {
    if (watcher || !existsSync(runsDir)) return;
    try {
      // Non-recursive: a new run appears as a new child dir of runsDir, which
      // fires here. (recursive:true isn't portable across Node/OS in v1.)
      watcher = watch(runsDir, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(broadcastRunsChanged, 150);
      });
    } catch {
      watcher = null; // watch unsupported → no auto-refresh, API still works
    }
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    if (method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    // ── JSON API ──────────────────────────────────────────────────────
    if (path === '/api/runs') {
      sendJson(res, 200, { runs: listRuns(runsDir) });
      return;
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path);
    if (runMatch) {
      const id = runMatch[1];
      const run = loadRun(runsDir, id); // returns null for invalid id / traversal
      if (!run) {
        sendJson(res, 404, { error: 'run not found', id });
        return;
      }
      sendJson(res, 200, run);
      return;
    }

    // ── SSE auto-refresh ──────────────────────────────────────────────
    if (path === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      sseClients.add(res);
      startWatch();
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ── static assets (viewer) ────────────────────────────────────────
    const assetPath = path === '/' ? 'index.html' : path.replace(/^\//, '');
    const abs = resolveAsset(publicDir, assetPath);
    if (!abs) {
      sendJson(res, 400, { error: 'bad path' });
      return;
    }
    if (existsSync(abs) && statSync(abs).isFile()) {
      const body = readFileSync(abs);
      res.writeHead(200, { 'content-type': MIME[extname(abs)] ?? 'application/octet-stream' });
      res.end(body);
      return;
    }
    sendJson(res, 404, { error: 'not found', path });
  });

  return new Promise<InspectHandle>((resolvePromise, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const url = `http://${host}:${actualPort}`;
      resolvePromise({
        url,
        host,
        port: actualPort,
        close: () =>
          new Promise<void>((res) => {
            if (watcher) watcher.close();
            if (debounce) clearTimeout(debounce);
            for (const c of sseClients) {
              try {
                c.end();
              } catch {
                /* ignore */
              }
            }
            sseClients.clear();
            server.close(() => res());
          }),
      });
    });
  });
}
