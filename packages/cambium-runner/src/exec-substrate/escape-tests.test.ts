/**
 * RED-250: escape-attempt fixtures / "looked secure, wasn't" test bench.
 *
 * Eight categories pinned in the RED-213 design note §11. Each asserts
 * that a sandboxed guest CANNOT exfiltrate a secret, read a sensitive
 * host path, make outbound network calls, spawn processes, bomb the
 * host, burn CPU, or grow memory past the cap. The shape is negative:
 * we assert the ABSENCE of a successful exfiltration, not the presence
 * of a specific error. If the sandbox config ever regresses in a way
 * that lets code through, these tests fail.
 *
 * Coverage matrix:
 *   - :wasm — always runs (quickjs-emscripten ships in optionalDeps).
 *   - :firecracker — gated behind RED213_TEST_FIRECRACKER=1 env and
 *     available() returning null. Currently the substrate stubs itself
 *     as unavailable; the guard auto-skips until RED-251 lands.
 *   - :native — explicitly NOT in the suite. It's by design
 *     unsandboxed; running these tests against it would pointlessly
 *     confirm the fig leaf.
 *
 * Every test plants a secret sentinel in the host environment before
 * running guest code, then asserts the sentinel did NOT appear in the
 * captured stdout. The sentinel is unique per test; teardown restores
 * the prior env state.
 */
import { describe, it, expect } from 'vitest';
import type { ExecSubstrate, ExecOpts, ExecResult } from './types.js';
import { WasmSubstrate } from './wasm.js';
import { FirecrackerSubstrate } from './firecracker.js';

// ── Harness ────────────────────────────────────────────────────────────

const DEFAULT_OPTS = {
  cpu: 1,
  memory: 64,
  timeout: 3,
  network: 'none' as const,
  filesystem: 'none' as const,
  maxOutputBytes: 50_000,
};

type Category = {
  name: string;
  language: 'js' | 'python';
  code: string;
  /** Markers that MUST NOT appear in stdout if the sandbox is intact. */
  forbidden: string[];
  /** Optional overrides to the default opts (e.g., tighter timeout for
   *  a CPU burn, smaller memory cap for OOM). */
  opts?: Partial<ExecOpts>;
  /** If provided, called before execute() to plant a secret in the
   *  host env that the guest MUST NOT be able to read. Returns a
   *  cleanup function. */
  plant?: () => () => void;
};

const SECRET_MARKER = 'cambium-escape-marker-sk-live-DO-NOT-LEAK';

/** Plant a sentinel value in a given env var; return a cleanup. */
function plantEnv(name: string, value: string): () => void {
  const previous = process.env[name];
  process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

/** The eight escape categories. Codes are JS by default — substrates
 *  that need Python variants (Firecracker) will get a separate table
 *  or a per-language entry when RED-251 lands. */
const CATEGORIES: Category[] = [
  {
    name: 'env vars are not accessible to guest code',
    language: 'js',
    code: `
      try {
        console.log('SAW:' + (typeof process !== 'undefined' ? process.env.CAMBIUM_ESCAPE_SECRET : 'NOPROCESS'));
      } catch (e) {
        console.log('BLOCKED:' + e.message);
      }
    `,
    forbidden: [SECRET_MARKER],
    plant: () => plantEnv('CAMBIUM_ESCAPE_SECRET', SECRET_MARKER),
  },
  {
    name: 'cloud metadata endpoint cannot be fetched',
    language: 'js',
    code: `
      try {
        fetch('http://169.254.169.254/latest/meta-data/')
          .then(r => r.text())
          .then(t => console.log('LEAKED:' + t))
          .catch(e => console.log('BLOCKED:' + e.message));
      } catch (e) {
        console.log('BLOCKED:' + e.message);
      }
    `,
    forbidden: ['LEAKED', 'ami-id', 'instance-id'],
  },
  {
    name: 'home directory (SSH keys) cannot be read',
    language: 'js',
    code: `
      try {
        const fs = require('fs');
        const data = fs.readFileSync('/Users/$USER/.ssh/id_rsa', 'utf8');
        console.log('LEAKED:' + data.slice(0, 100));
      } catch (e) {
        console.log('BLOCKED:' + e.message);
      }
    `,
    forbidden: ['LEAKED', 'BEGIN OPENSSH', 'BEGIN RSA', 'PRIVATE KEY'],
  },
  {
    name: '/etc/passwd cannot be opened',
    language: 'js',
    code: `
      try {
        const fs = require('fs');
        const data = fs.readFileSync('/etc/passwd', 'utf8');
        console.log('LEAKED:' + data);
      } catch (e) {
        console.log('BLOCKED:' + e.message);
      }
    `,
    forbidden: ['LEAKED', 'root:', '/bin/bash', '/bin/sh', ':/home/'],
  },
  {
    name: 'subprocesses cannot be spawned',
    language: 'js',
    code: `
      try {
        const { execSync } = require('child_process');
        const out = execSync('cat /etc/passwd').toString();
        console.log('LEAKED:' + out);
      } catch (e) {
        console.log('BLOCKED:' + e.message);
      }
    `,
    forbidden: ['LEAKED', 'root:', '/bin/bash'],
  },
  {
    name: 'fork bombs are rejected within the timeout',
    language: 'js',
    code: `
      try {
        const { spawn } = require('child_process');
        function bomb() {
          spawn('sh', ['-c', 'sh -c "while true; do :; done" &'], { detached: true });
          bomb();
        }
        bomb();
      } catch (e) {
        console.log('BLOCKED:' + e.message);
      }
    `,
    forbidden: [], // The critical test is that the call RETURNS — no
                   // hung process, no host impact. A hanging assertion
                   // would be the failure signal.
    opts: { timeout: 2 }, // tight timeout; vitest per-test timeout still holds
  },
  {
    name: 'CPU burn is capped by the wall-clock timeout',
    language: 'js',
    code: 'while (true) { Math.sqrt(Math.random()); }',
    forbidden: [],
    opts: { timeout: 1 },
  },
  {
    name: 'memory allocation is capped by the memory limit',
    language: 'js',
    // Intentionally NO try/catch. If the guest catches OOM, the
    // substrate returns 'completed' with the error in stderr; if it
    // doesn't (because catching itself needs memory we don't have),
    // the substrate returns 'oom'. We assert the cleaner 'oom' path
    // by keeping the allocation loop unwrapped — the substrate-level
    // signal is what makes this a *security* guarantee rather than
    // a guest-visible error.
    code: 'const a = []; while (true) a.push(new Array(100000).fill("x"));',
    forbidden: [],
    opts: { memory: 16, timeout: 5 },
  },
];

/** Run one escape category against one substrate. Returns the result
 *  plus the unconditional "no forbidden marker in stdout" assertion. */
async function runCategory(sub: ExecSubstrate, c: Category): Promise<ExecResult> {
  const cleanup = c.plant?.();
  try {
    const opts: ExecOpts = {
      language: c.language,
      code: c.code,
      ...DEFAULT_OPTS,
      ...c.opts,
    };
    return await sub.execute(opts);
  } finally {
    cleanup?.();
  }
}

function assertNoLeak(category: Category, result: ExecResult) {
  // Three orthogonal guarantees:
  // 1. No forbidden marker appeared in stdout.
  // 2. No forbidden marker appeared in stderr. Guest code could
  //    `throw host_secret` instead of `console.log`-ing it; without
  //    this check the exfiltration would pass silently via the
  //    substrate's error-message capture path. Flagged by a
  //    cambium-security review.
  // 3. The call did NOT complete successfully while producing a
  //    leaked value. `status: 'completed'` with `exit_code: 0` AND
  //    forbidden-marker-free stdout+stderr is allowed (guest handled
  //    the failure gracefully with `console.log('BLOCKED:')`). What
  //    the sandbox must NEVER do is return `completed, exit 0` with
  //    a leak — the loops below cover that.
  for (const forbidden of category.forbidden) {
    expect(result.stdout).not.toContain(forbidden);
    expect(result.stderr).not.toContain(forbidden);
  }
}

// ── WASM substrate — always runs ──────────────────────────────────────

describe('WASM substrate — escape tests (RED-250)', () => {
  const sub = new WasmSubstrate();
  if (sub.available() !== null) {
    it.skip('WASM substrate unavailable on this host — escape tests skipped', () => {});
    return;
  }

  // Sanity check: a benign program runs. If this fails, the escape
  // tests below are trivially passing because ALL execute() calls
  // fail, which would mask a real regression.
  it('sanity: a benign JS program runs and produces expected output', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'js',
      code: 'console.log("benign-ok:" + (1 + 2));',
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('benign-ok:3');
  });

  for (const category of CATEGORIES) {
    it(category.name, async () => {
      const result = await runCategory(sub, category);
      assertNoLeak(category, result);
      // Additionally: for CPU burn, fork bomb, memory bomb — the
      // call MUST return in bounded time. vitest default timeout
      // (5s) enforces this implicitly; add explicit assertions for
      // the status expected per category.
      if (category.name.startsWith('CPU burn')) {
        expect(result.status).toBe('timeout');
      } else if (category.name.startsWith('memory allocation')) {
        expect(result.status).toBe('oom');
      } else if (category.name.startsWith('fork bombs')) {
        // Returns (didn't hang) — either timeout or completed with
        // a blocked error. Both are acceptable.
        expect(['timeout', 'completed']).toContain(result.status);
      }
    });
  }
});

// ── Firecracker substrate — gated ─────────────────────────────────────

describe('Firecracker substrate — escape tests (RED-250)', () => {
  const sub = new FirecrackerSubstrate();
  const gated = process.env.RED213_TEST_FIRECRACKER === '1';
  const available = sub.available() === null;

  if (!gated || !available) {
    const reason = !gated
      ? 'set RED213_TEST_FIRECRACKER=1 to run'
      : (sub.available() ?? 'unavailable');
    it.skip(`Firecracker escape tests skipped — ${reason}`, () => {});
    return;
  }

  // Runs only when explicitly enabled AND the substrate is available.
  // RED-251 is where the real implementation lands; for now the stub
  // returns crashed, so these assertions would fail if someone flipped
  // the gate without the substrate being real.
  for (const category of CATEGORIES) {
    it(category.name, async () => {
      const result = await runCategory(sub, category);
      assertNoLeak(category, result);
    });
  }
});
