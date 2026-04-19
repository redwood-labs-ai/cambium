/**
 * RED-257: escape-test matrix replay against the `:firecracker` substrate.
 *
 * Mirrors the eight RED-213 design-note §11 categories against the
 * Firecracker substrate shipped in RED-251. Enforcement mechanisms
 * diverge from WASM — where WASM blocks by not exposing the capability
 * at all (no `fs`, no `fetch`, no `process.env`), Firecracker blocks
 * by running the guest in a separate kernel / filesystem / network
 * namespace. Each `it` block documents *why* the assertion holds for
 * Firecracker specifically, not just *that* it does.
 *
 * Gated: runs only when BOTH
 *   - `RED213_TEST_FIRECRACKER=1` is set in the env
 *   - `FirecrackerSubstrate.available()` returns null
 *     (i.e., Linux + KVM + firecracker on PATH + `CAMBIUM_FC_KERNEL`
 *     and `CAMBIUM_FC_ROOTFS` both point at existing files)
 * Skipped with a visible reason otherwise — the MS-R1 is the expected
 * run target; dev Macs skip the whole block.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ExecOpts } from './types.js';
import { FirecrackerSubstrate } from './firecracker.js';

const SECRET_MARKER = `cambium-escape-marker-${randomBytes(8).toString('hex')}`;

// Per-test vitest timeout. A cold-boot + round-trip on the R1 was
// ~310 ms; with interpreter-level timeouts up to a few seconds, 30s
// is comfortably over the worst-case path and tight enough to catch
// a hung VM early rather than letting it block CI for minutes.
const VITEST_TIMEOUT_MS = 30_000;

// Memory is 512 MiB to match the RED-256 canonical snapshot sizing.
// When this suite runs under the `:firecracker` substrate with the
// snapshot cache available (not disabled via CAMBIUM_FC_DISABLE_SNAPSHOTS=1),
// using the canonical size is what makes the assertion "isolation holds
// under warm-restore too" actually triggerable. Any other memory value
// would bypass the snapshot path via `non_canonical_sizing` fallback
// and test only the cold-boot path — which RED-257's original run
// already covered.
const DEFAULT_OPTS: Omit<ExecOpts, 'language' | 'code'> = {
  cpu: 1,
  memory: 512,
  timeout: 5,
  network: 'none',
  filesystem: 'none',
  maxOutputBytes: 50_000,
};

describe('Firecracker substrate — escape tests (RED-257)', () => {
  const sub = new FirecrackerSubstrate();
  const gated = process.env.RED213_TEST_FIRECRACKER === '1';
  const availableReason = sub.available();

  if (!gated || availableReason !== null) {
    const reason = !gated
      ? 'set RED213_TEST_FIRECRACKER=1 to run (needs Linux + KVM + firecracker + CAMBIUM_FC_KERNEL + CAMBIUM_FC_ROOTFS)'
      : (availableReason ?? 'substrate unavailable');
    // Emits a single visible SKIP in test output. Clearer than silently
    // dropping the whole block.
    it.skip(`skipped — ${reason}`, () => {});
    return;
  }

  // Host-only sentinel file used by the filesystem + subprocess
  // categories. The guest must NEVER be able to read this — it lives
  // on the host's /tmp and there are no bind-mount drives in v1. The
  // `SECRET_MARKER` written here is the forbidden string each test
  // asserts NEVER appears in guest output.
  let hostDir: string;
  let hostSentinelPath: string;
  beforeAll(() => {
    hostDir = mkdtempSync(join(tmpdir(), 'cambium-escape-host-'));
    hostSentinelPath = join(hostDir, 'sentinel');
    writeFileSync(hostSentinelPath, SECRET_MARKER, { mode: 0o644 });
  });
  afterAll(() => {
    try { rmSync(hostDir, { recursive: true, force: true }); } catch {}
  });

  const ENV_NAME = 'CAMBIUM_ESCAPE_SECRET';
  function plantEnv(): () => void {
    const prev = process.env[ENV_NAME];
    process.env[ENV_NAME] = SECRET_MARKER;
    return () => {
      if (prev === undefined) delete process.env[ENV_NAME];
      else process.env[ENV_NAME] = prev;
    };
  }

  // ── Sanity ───────────────────────────────────────────────────────────
  //
  // If these fail, every escape assertion below is trivially passing
  // because `execute()` never returns real output — which would mask
  // a genuine regression. Keep these at the top so failures show up
  // first.

  it('sanity: a benign JS program runs and produces expected output', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'js',
      code: 'console.log("benign-ok:" + (1 + 2));',
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('benign-ok:3');
  }, VITEST_TIMEOUT_MS);

  it('sanity: a benign Python program runs and produces expected output', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'python',
      code: 'print("py-ok:", 3 + 4)',
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('py-ok:');
  }, VITEST_TIMEOUT_MS);

  // ── 1. Env var egress ────────────────────────────────────────────────
  //
  // Why this passes for Firecracker: the guest agent calls
  // `Command::env_clear()` before spawning the Node/Python subprocess
  // (see `crates/cambium-agent/src/spawn.rs`). The host's process.env
  // is never propagated through the vsock request — only `ExecRequest`
  // fields cross the boundary, and that payload carries code + caps,
  // not an env-var map. The guest's `process.env.CAMBIUM_ESCAPE_SECRET`
  // resolves to `undefined`.

  it('env vars are not accessible to guest code', async () => {
    const cleanup = plantEnv();
    try {
      const result = await sub.execute({
        ...DEFAULT_OPTS,
        language: 'js',
        code: 'console.log("SAW:" + (process.env.CAMBIUM_ESCAPE_SECRET ?? "UNDEFINED"));',
      });
      expect(result.stdout).not.toContain(SECRET_MARKER);
      expect(result.stderr).not.toContain(SECRET_MARKER);
      expect(result.stdout).toContain('SAW:UNDEFINED');
      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
    } finally {
      cleanup();
    }
  }, VITEST_TIMEOUT_MS);

  // ── 2. Cloud metadata ────────────────────────────────────────────────
  //
  // Why this passes for Firecracker: `:firecracker` v1 ships
  // `network: 'none'` at the Firecracker VM config level — no veth
  // pair, no tap interface, no netns routes. The only transport the
  // guest has is vsock, and vsock isn't routable to IP addresses.
  // Guest `fetch()` fails at the DNS/connect layer.

  it('cloud metadata endpoint cannot be fetched', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'js',
      code: `
        fetch('http://169.254.169.254/latest/meta-data/', { signal: AbortSignal.timeout(2000) })
          .then(r => r.text())
          .then(t => console.log('LEAKED:' + t))
          .catch(e => console.log('BLOCKED:' + e.message));
      `,
    });
    expect(result.stdout).not.toContain('LEAKED');
    expect(result.stdout).not.toContain('ami-id');
    expect(result.stdout).not.toContain('instance-id');
  }, VITEST_TIMEOUT_MS);

  // ── 3. Host filesystem isolation ─────────────────────────────────────
  //
  // Why this passes for Firecracker: the guest's root is the RED-255
  // rootfs ext4 image mounted as `/dev/vda`. Only the allowlist entries
  // declared in `filesystem: { allowlist_paths: [...] }` get
  // additional virtio-blk drives (vdb..vdy). Any host path not in the
  // allowlist fails with ENOENT — including the sentinel file we
  // planted in the host's /tmp.
  //
  // Note: tests using host-specific paths like `/etc/passwd` don't
  // work for Firecracker because the guest has its OWN /etc/passwd
  // (Alpine's, starting with `root:`). The forbidden-marker approach
  // would false-positive on Alpine's own passwd. Planting a unique
  // host sentinel file and checking that the marker doesn't appear in
  // guest output is the portable invariant.

  it('host sentinel file cannot be read from guest (no allowlist)', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'js',
      code: `
        try {
          const fs = require('fs');
          const data = fs.readFileSync(${JSON.stringify(hostSentinelPath)}, 'utf8');
          console.log('LEAKED:' + data);
        } catch (e) {
          console.log('BLOCKED:' + e.message);
        }
      `,
    });
    expect(result.stdout).not.toContain(SECRET_MARKER);
    expect(result.stderr).not.toContain(SECRET_MARKER);
    expect(result.stdout).toContain('BLOCKED');
  }, VITEST_TIMEOUT_MS);

  // ── 3b. Allowlist — positive + scoping (RED-258) ─────────────────────
  //
  // The v1 allowlist grants read-only access to declared host
  // directories via per-path ext4 images attached as virtio-blk. What
  // we assert here:
  //   (a) An allowlisted host dir IS readable inside the guest —
  //       without this, the feature doesn't work.
  //   (b) An unrelated host dir remains invisible even when the
  //       allowlist grants access to something else — confirms the
  //       allowlist doesn't function as a blanket "host access" flag.
  //
  // The allowlist scratch dir is created under $HOME so it passes
  // validation (the DEEP_FORBIDDEN list blocks /tmp / /var / etc at
  // subpath level; /home is EXACT_FORBIDDEN, so /home/<user>/... is
  // fine). On the R1 under a non-root user this is `/home/$USER/...`;
  // under any host where $HOME resolves to a forbidden prefix (running
  // as root gets you `/root`), the allowlist validator would reject
  // and the tests would fail with a clear reason.

  let allowDir: string;
  let allowSentinelPath: string;
  const ALLOW_MARKER = `cambium-allow-marker-${randomBytes(8).toString('hex')}`;
  beforeAll(() => {
    allowDir = mkdtempSync(join(homedir(), '.cambium-escape-allow-'));
    allowSentinelPath = join(allowDir, 'data.txt');
    writeFileSync(allowSentinelPath, ALLOW_MARKER, { mode: 0o644 });
  });
  afterAll(() => {
    try { rmSync(allowDir, { recursive: true, force: true }); } catch {}
  });

  it('allowlisted host dir IS readable from guest', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      filesystem: { allowlist_paths: [allowDir] },
      language: 'js',
      code: `
        try {
          const fs = require('fs');
          const data = fs.readFileSync(${JSON.stringify(allowSentinelPath)}, 'utf8');
          console.log('READ:' + data);
        } catch (e) {
          console.log('BLOCKED:' + e.message);
        }
      `,
    });
    expect(result.status).toBe('completed');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('READ:');
    expect(result.stdout).toContain(ALLOW_MARKER);
  }, VITEST_TIMEOUT_MS);

  it('non-allowlisted host dir stays invisible when another path IS allowlisted', async () => {
    // The allowlist grants access to `allowDir` — NOT to `hostDir`
    // (which is under the host's /tmp and holds `SECRET_MARKER`). The
    // guest must not see that unrelated directory, confirming the
    // allowlist is path-scoped rather than a blanket host-access bit.
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      filesystem: { allowlist_paths: [allowDir] },
      language: 'js',
      code: `
        try {
          const fs = require('fs');
          const data = fs.readFileSync(${JSON.stringify(hostSentinelPath)}, 'utf8');
          console.log('LEAKED:' + data);
        } catch (e) {
          console.log('BLOCKED:' + e.message);
        }
      `,
    });
    expect(result.stdout).not.toContain(SECRET_MARKER);
    expect(result.stderr).not.toContain(SECRET_MARKER);
    expect(result.stdout).toContain('BLOCKED');
  }, VITEST_TIMEOUT_MS);

  it('allowlist mount is read-only — guest writes are rejected', async () => {
    // Host-side hardcodes read_only: true, and the agent refuses any
    // read_only: false mount as belt-and-suspenders. The in-guest
    // `mount -o ro` makes writes fail with EROFS. This test confirms
    // the end-to-end read-only invariant from guest code's POV.
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      filesystem: { allowlist_paths: [allowDir] },
      language: 'js',
      code: `
        try {
          const fs = require('fs');
          fs.writeFileSync(${JSON.stringify(join(allowDir, 'guest-write.txt'))}, 'SHOULD-NOT-WRITE');
          console.log('WROTE');
        } catch (e) {
          console.log('BLOCKED:' + e.code + ':' + e.message);
        }
      `,
    });
    expect(result.stdout).not.toContain('WROTE');
    expect(result.stdout).toContain('BLOCKED');
    // EROFS is the canonical read-only-filesystem errno; EACCES is a
    // plausible alternate on some busybox configs. Either is fine;
    // what we care about is that the write didn't succeed.
    expect(result.stdout).toMatch(/EROFS|EACCES/);
  }, VITEST_TIMEOUT_MS);

  // ── 4. Arbitrary outbound network ────────────────────────────────────
  //
  // Why this passes for Firecracker: same rationale as cloud metadata
  // — `network: 'none'` means no network device is routable to the
  // outside world. Any outbound connection fails regardless of target.

  it('arbitrary outbound connections are denied', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'js',
      code: `
        fetch('http://api.github.com/', { signal: AbortSignal.timeout(2000) })
          .then(r => console.log('LEAKED: status', r.status))
          .catch(e => console.log('BLOCKED:' + e.message));
      `,
    });
    expect(result.stdout).not.toContain('LEAKED');
  }, VITEST_TIMEOUT_MS);

  // ── 5. Subprocess containment ────────────────────────────────────────
  //
  // Why this passes for Firecracker: the guest CAN spawn subprocesses
  // (Alpine has `sh`, `cat`, etc., and Node's `child_process.execSync`
  // works inside the VM). But the spawned subprocess inherits the VM's
  // filesystem view — it's still chrooted to the guest rootfs. It
  // CANNOT reach host paths.
  //
  // This is a *subtly different* assertion than the WASM version,
  // which holds because `child_process` doesn't exist in QuickJS at
  // all. Firecracker's guarantee is "subprocesses run, but can't
  // escape the VM boundary" — same outcome, different mechanism.

  it('spawned subprocesses cannot reach host filesystem', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'js',
      code: `
        try {
          const { execSync } = require('child_process');
          const out = execSync(${JSON.stringify(`cat ${hostSentinelPath}`)}).toString();
          console.log('LEAKED:' + out);
        } catch (e) {
          console.log('BLOCKED:' + (e.stderr?.toString() ?? e.message));
        }
      `,
    });
    expect(result.stdout).not.toContain(SECRET_MARKER);
    expect(result.stderr).not.toContain(SECRET_MARKER);
  }, VITEST_TIMEOUT_MS);

  // ── 6. Timeout enforcement ───────────────────────────────────────────
  //
  // Why this passes for Firecracker: the agent enforces
  // `ExecRequest.timeout_seconds` by `SIGKILL`-ing the interpreter
  // subprocess (`crates/cambium-agent/src/spawn.rs`). Additionally,
  // the host-side substrate enforces a read timeout on the
  // `ExecResponse` as belt-and-suspenders — if the agent itself hangs,
  // we tear down the VM via the Firecracker API after the deadline.
  // Either way the guest cannot burn host CPU past the wall clock.

  it('CPU burn is capped by the wall-clock timeout', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'js',
      code: 'while (true) { Math.sqrt(Math.random()); }',
      timeout: 2,
    });
    expect(result.status).toBe('timeout');
    expect(result.reason).toMatch(/timeout/i);
  }, VITEST_TIMEOUT_MS);

  // ── 7. Memory enforcement ────────────────────────────────────────────
  //
  // Why this passes for Firecracker: the VM's memory cap is set via
  // `PUT /machine-config`'s `mem_size_mib`. When guest code exhausts
  // it, the kernel OOM-killer inside the VM fires and SIGKILLs the
  // interpreter subprocess (exit code 137). The agent sees the 137,
  // classifies it as `oom`, and reports back. The host is never
  // affected — only the guest VM's allocation pool.

  it('memory allocation is capped by the VM mem_size_mib', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'js',
      code: 'const a = []; while (true) a.push(new Array(100000).fill("x"));',
      memory: 128,
      timeout: 10,
    });
    expect(result.status).toBe('oom');
  }, VITEST_TIMEOUT_MS);

  // ── 8. Output-size enforcement ───────────────────────────────────────
  //
  // Why this passes for Firecracker: the agent caps its per-stream
  // output buffer at `max_output_bytes` from the request and sets
  // `truncated_stdout`/`truncated_stderr` on the response. The host
  // substrate also truncates via `truncate()` against
  // `opts.maxOutputBytes` as a second line of defense. Either the
  // agent's truncation, the host's truncation, or both produce the
  // final `truncated.stdout: true` signal on the ExecResult.

  it('stdout past maxOutputBytes is truncated with the flag set', async () => {
    const result = await sub.execute({
      ...DEFAULT_OPTS,
      language: 'js',
      code: 'for (let i = 0; i < 10000; i++) console.log("xxxxxxxxxxxxxxxxxxxx");',
      maxOutputBytes: 1_000,
    });
    expect(result.status).toBe('completed');
    expect(result.truncated.stdout).toBe(true);
    expect(result.stdout).toContain('[truncated at 1000 bytes]');
  }, VITEST_TIMEOUT_MS);
});
