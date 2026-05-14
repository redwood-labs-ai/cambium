"""Pytest fixtures for integration tests against a real `cambium serve`.

The unit-layer tests in `test_client_*.py` use `httpx.MockTransport` and
don't need any of this — these fixtures only fire for `test_integration*`
modules that explicitly request them.

Architecture:

* `runner_bin` resolves the in-repo Cambium CLI entry (`cli/cambium.mjs`).
  Skips the whole module if `packages/cambium-runner/dist/` isn't built,
  with a clear "run npm run build" pointer.

* `serve_workspace` builds a tmp workspace (Genfile + .cmb.rb + permissive
  contracts) the server can boot against.

* `serve_url` spawns `node <cli> serve --bind tcp://127.0.0.1:0 ...` with
  `CAMBIUM_ALLOW_MOCK=1`, reads stderr for the
  `[cambium serve] listening on tcp://HOST:PORT` line Phase 1's
  `cli/serve.mjs:112` emits, then probes `/v1/healthz` until the catalog
  returns 200. Yields the base URL. Teardown via SIGTERM with a 5s
  drain + kill fallback (Phase 1's `--shutdown-timeout=30s` handles
  the graceful path).
"""

from __future__ import annotations

import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Iterator

import httpx
import pytest


# ── repo root + CLI discovery ────────────────────────────────────────


def _repo_root() -> Path:
    """Walk up from this file to the workspace root.

    tests/conftest.py → cambium-client-python/ → packages/ → workspace root.
    """
    return Path(__file__).resolve().parents[3]


@pytest.fixture(scope="session")
def runner_bin() -> str:
    """Resolve the `cambium` CLI entry point.

    Skips the entire integration suite if the runner package's `dist/`
    isn't built — the CLI imports `@redwood-labs/cambium-runner` which
    resolves to `dist/index.js` via the npm workspace symlink.
    """
    cli = _repo_root() / "cli" / "cambium.mjs"
    if not cli.exists():
        pytest.skip(f"cambium CLI not found at {cli}")
    dist = _repo_root() / "packages" / "cambium-runner" / "dist" / "index.js"
    if not dist.exists():
        pytest.skip(
            f"runner package not built (looked for {dist}). "
            "Run `npm run build` in packages/cambium-runner first."
        )
    if shutil.which("node") is None:
        pytest.skip("node not on PATH")
    return str(cli)


# ── tmp workspace ────────────────────────────────────────────────────


_FIXTURE_GEN = """\
class TinyGen < GenModel
  model "ollama:test"
  system "test prompt"
  returns AnalysisReport

  def analyze(doc)
    generate "do the thing" do
      with context: doc
      returns AnalysisReport
    end
  end
end
"""

# Permissive contracts so the mock provider's `{summary, metrics,
# key_facts}` payload validates against `AnalysisReport`. Plain
# object-literal export — no `@sinclair/typebox` dependency in the
# tmp workspace.
_FIXTURE_CONTRACTS = """\
export const AnalysisReport = {
  $id: 'AnalysisReport',
  type: 'object',
  additionalProperties: true,
};
"""

_FIXTURE_GENFILE = """\
[package]
name = "cambium-client-integration-test"

[types]
contracts = ["src/contracts.ts"]

[exports.gens]
TinyGen = "app/gens/tiny.cmb.rb"
"""


@pytest.fixture
def serve_workspace(tmp_path: Path) -> Path:
    """Build a minimal Cambium workspace the server can boot against."""
    (tmp_path / "app" / "gens").mkdir(parents=True)
    (tmp_path / "src").mkdir()
    (tmp_path / "app" / "gens" / "tiny.cmb.rb").write_text(_FIXTURE_GEN)
    (tmp_path / "src" / "contracts.ts").write_text(_FIXTURE_CONTRACTS)
    (tmp_path / "Genfile.toml").write_text(_FIXTURE_GENFILE)
    # The runner's `loadContractsFromGenfile` does a dynamic
    # `import(pathToFileURL(contracts.ts))`. tsx's loader intercepts
    # the .ts compile, but Node decides the OUTPUT module type from
    # the nearest `package.json#type`. Without one, the file is
    # treated as CommonJS and tsx's "Cannot require() ES Module ...
    # in a cycle" error surfaces. A minimal `{"type":"module"}` in
    # the workspace pins ESM resolution for the import path.
    (tmp_path / "package.json").write_text('{"type": "module"}\n')
    return tmp_path


# ── spawn + ready-line parser ────────────────────────────────────────


_LISTENING_RE = re.compile(
    r"\[cambium serve\]\s+listening on\s+(\S+)"
)


def _await_ready(proc: subprocess.Popen[str], *, timeout: float) -> str:
    """Read the spawned server's stderr until the listening line shows up.

    Phase 1's `cli/serve.mjs:112` emits:
        [cambium serve] listening on tcp://HOST:PORT

    We grep that with a regex, with a deadline. Stderr is streamed line
    by line on a background thread so a Popen.communicate-style read
    doesn't block the timeout (the server keeps printing other lines —
    `workspace: ...`, run trace pointers, etc.).
    """
    assert proc.stderr is not None
    found: list[str] = []
    error_lines: list[str] = []
    lock = threading.Lock()

    def _drain() -> None:
        for line in proc.stderr:  # type: ignore[union-attr]
            with lock:
                error_lines.append(line)
                if not found:
                    match = _LISTENING_RE.search(line)
                    if match:
                        found.append(match.group(1))

    drainer = threading.Thread(target=_drain, daemon=True)
    drainer.start()

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with lock:
            if found:
                return found[0]
            if proc.poll() is not None:
                # Server died before emitting the ready line.
                break
        time.sleep(0.05)

    # Timed out or process exited. Surface the captured stderr so the
    # operator can diagnose. The drainer thread is daemonised so it
    # dies with the test process.
    with lock:
        captured = "".join(error_lines[-50:])  # tail
    proc.terminate()
    raise RuntimeError(
        f"cambium serve did not log 'listening on tcp://...' within "
        f"{timeout}s. Tail of stderr:\n{captured}"
    )


@pytest.fixture
def serve_url(runner_bin: str, serve_workspace: Path) -> Iterator[str]:
    """Boot `cambium serve` for the duration of a single test."""
    # Forward the full parent environment to the spawned server so
    # PATH, NODE_PATH, etc. work. `CAMBIUM_ALLOW_MOCK=1` short-circuits
    # the model dispatch, so any real API keys (CAMBIUM_OMLX_API_KEY,
    # ANTHROPIC_API_KEY) the developer has set are present in the
    # subprocess env but never used. CI environments shouldn't have
    # real keys to begin with; flag this for any future fixture that
    # captures stderr — don't accidentally log env contents.
    env = {**os.environ, "CAMBIUM_ALLOW_MOCK": "1"}
    proc = subprocess.Popen(
        [
            "node", runner_bin,
            "serve",
            "--bind", "tcp://127.0.0.1:0",
            "--workspace", str(serve_workspace),
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        # Phase 1 logs `tcp://HOST:PORT` (matching its `--bind` syntax).
        # httpx's HTTP Client wants `http://` — rewrite for the probe.
        # CambiumClient's parse_url handles both forms, so we could yield
        # tcp:// instead, but http:// is more conventional + httpx-direct
        # tooling that gets shown the URL works without rewriting too.
        tcp_url = _await_ready(proc, timeout=15.0)
        base_url = tcp_url.replace("tcp://", "http://", 1)
        # Confirm /v1/healthz is actually serving — boot could log
        # "listening on" before the HTTP handler is fully wired up.
        deadline = time.monotonic() + 5.0
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            try:
                with httpx.Client(timeout=2.0) as c:
                    r = c.get(f"{base_url}/v1/healthz")
                if r.status_code == 200:
                    break
            except httpx.HTTPError as e:
                last_err = e
            time.sleep(0.1)
        else:
            raise RuntimeError(
                f"server logged 'listening' but /v1/healthz never returned 200. "
                f"Last error: {last_err}"
            )
        yield base_url
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2.0)


# ── UDS fixture (slice 7) ────────────────────────────────────────────


# macOS `sun_path` limit: 104 bytes. Linux: 108. Pick the smaller as
# the safe ceiling. The OS would fail bind() with EINVAL/ENAMETOOLONG
# on overrun; checking here surfaces a clearer error.
_SUN_PATH_MAX = 104


def _short_uds_path() -> Path:
    """Pick a Unix-socket path under `tempfile.gettempdir()` directly.

    macOS's `sun_path` is 104 bytes. pytest's `tmp_path` lives under
    `/var/folders/.../pytest-of-.../...` which can easily exceed that
    even before we append a filename. The system tempdir (usually
    `/tmp` or a short equivalent) is the safe choice.

    Defensive: if `TMPDIR` is set to an unusually long path on a
    developer's machine, even `tempfile.gettempdir() + cm-PID-…`
    could overrun the limit. Check explicitly and raise with a clear
    message rather than letting bind() fail with an obscure OSError.
    """
    # PID + monotonic + random — avoids collisions across parallel test
    # runs and stale sockets from earlier process crashes.
    name = f"cm-{os.getpid()}-{int(time.monotonic_ns())}-{random.randint(0, 9999)}.sock"
    path = Path(tempfile.gettempdir()) / name
    encoded_len = len(os.fsencode(str(path)))
    if encoded_len > _SUN_PATH_MAX:
        raise RuntimeError(
            f"UDS socket path is {encoded_len} bytes, exceeds {_SUN_PATH_MAX} "
            f"(macOS sun_path limit). Set TMPDIR to a shorter path. Got: {path}"
        )
    return path


@pytest.fixture
def serve_url_uds(runner_bin: str, serve_workspace: Path) -> Iterator[str]:
    """Boot `cambium serve --bind unix:///tmp/cm-*.sock` for one test."""
    if sys.platform == "win32":
        pytest.skip("UDS not supported on Windows in v1 (use pipe:// in v1.1)")

    sock_path = _short_uds_path()
    bind_uri = f"unix://{sock_path}"

    # Forward the full parent environment to the spawned server so
    # PATH, NODE_PATH, etc. work. `CAMBIUM_ALLOW_MOCK=1` short-circuits
    # the model dispatch, so any real API keys (CAMBIUM_OMLX_API_KEY,
    # ANTHROPIC_API_KEY) the developer has set are present in the
    # subprocess env but never used. CI environments shouldn't have
    # real keys to begin with; flag this for any future fixture that
    # captures stderr — don't accidentally log env contents.
    env = {**os.environ, "CAMBIUM_ALLOW_MOCK": "1"}
    proc = subprocess.Popen(
        [
            "node", runner_bin,
            "serve",
            "--bind", bind_uri,
            "--workspace", str(serve_workspace),
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        # Wait for the "listening on" line — the URL form will match
        # what we asked for (`unix:///tmp/...`).
        listened_url = _await_ready(proc, timeout=15.0)
        # Sanity: confirm the server actually echoed back our socket
        # path. If it ever diverges, the test surfaces the mismatch
        # rather than silently connecting somewhere else.
        assert listened_url == bind_uri, (
            f"server logged unexpected bind URL: got {listened_url}, "
            f"asked for {bind_uri}"
        )
        # Probe healthz via CambiumClient (which knows how to UDS).
        # Imported locally to avoid coupling slice 6's fixture file to
        # the package import order — the package is `pip install -e`'d
        # by the test harness.
        from cambium_client import CambiumClient as _Client

        deadline = time.monotonic() + 5.0
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            try:
                with _Client(url=bind_uri, timeout=2.0) as c:
                    c.healthz()
                break
            except Exception as e:  # noqa: BLE001 — probe is best-effort
                last_err = e
                time.sleep(0.1)
        else:
            raise RuntimeError(
                f"UDS server logged 'listening' at {bind_uri} but healthz "
                f"never responded. Last error: {last_err}"
            )
        yield bind_uri
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2.0)
        # Best-effort socket cleanup. The server SHOULD remove the
        # socket on shutdown; if it didn't (process killed), nuke it
        # so the next test run doesn't trip over a stale file.
        try:
            sock_path.unlink(missing_ok=True)
        except OSError:
            pass
