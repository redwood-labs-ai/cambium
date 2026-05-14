# cambium-client

Python client for [Cambium](https://github.com/redwood-labs-ai/cambium) serve mode (RED-360). Speaks the v1 HTTP wire format — `pip install cambium-client`, point at a running `cambium serve` process, call gens.

The transport for non-Node hosts (FastAPI, Django, Flask, Go via HTTP, Elixir, anything that needs warm Cambium without a Node bridge). One `httpx`-backed `CambiumClient` exposes both sync and async paths from the same connection pool.

## Install

```bash
pip install cambium-client
```

Requires Python 3.10+. Single runtime dependency: `httpx>=0.27.2`.

## Quickstart

Run `cambium serve` somewhere reachable (loopback for the same-host case; Docker network for sidecar):

```bash
cambium serve --workspace ./cambium --bind tcp://127.0.0.1:9000
```

Then from Python:

```python
from cambium_client import CambiumClient

# Sync
with CambiumClient(url="http://127.0.0.1:9000") as client:
    output = client.run("ResumeParser", "analyze", resume_text)
    # → whatever the gen's `returns` schema produced

# Async
async with CambiumClient(url="http://127.0.0.1:9000") as client:
    output = await client.run_async("ResumeParser", "analyze", resume_text)
```

`client.run()` returns the bare `output` dict on success. Failures raise a typed `CambiumError` subclass — see [Errors](#errors) below.

## Transports

| Scheme | v1 support | Notes |
| -- | -- | -- |
| `http://host:port` / `https://...` | ✅ | Standard `httpx` HTTP transport. |
| `tcp://host:port` | ✅ | Convenience form (matches `cambium serve --bind`); rewritten to `http://`. |
| `unix:///abs/path` | ✅ | UDS via `httpx.HTTPTransport(uds=...)`. Mac / Linux. |
| `pipe://name` | ❌ (v1.1) | Windows named pipes — raises `NotImplementedError` until v1.1. Use `tcp://127.0.0.1:<port>` on Windows in v1. |

## API

### `CambiumClient(url, *, timeout=30.0, headers=None, probe=False)`

| Argument | Type | Default | Notes |
| -- | -- | -- | -- |
| `url` | `str` | (required) | Server URL. See [Transports](#transports). |
| `timeout` | `float` | `30.0` | Per-request timeout in seconds. |
| `headers` | `Mapping[str, str]` | `None` | Extra HTTP headers (e.g. tracing). |
| `probe` | `bool` | `False` | If `True`, call `/v1/healthz` from the constructor and raise `CambiumConnectionError` if the server isn't reachable (or `BootingError` if it's still loading gens). |

### `client.run(gen, method, input, *, memory_keys=None, fired_by=None, include_trace=False)`

Dispatch a gen run. Returns the bare `output` from the response on success; raises a `CambiumError` subclass on failure.

| Argument | Type | Notes |
| -- | -- | -- |
| `gen` | `str` | Gen export name from the server's `Genfile.toml [exports.gens]`. |
| `method` | `str` | Public method on the GenModel (typically `analyze`). |
| `input` | `str \| dict \| list \| bytes` | Bytes are decoded UTF-8 (JSON can't carry raw bytes). Dicts/lists pass through unchanged; the server stringifies non-string `input` values into `ir.context.<source>`. |
| `memory_keys` | `Mapping[str, str]` | Values for `keyed_by` memory slots. Forwarded to the server as a dict. |
| `fired_by` | `str` | Schedule id for `cron`-fired runs (e.g. `"schedule:daily.x"`). |
| `include_trace` | `bool` | If `True`, the server returns the trace inline. The current `run()` API still returns just the output; trace surfacing in the response is a follow-up (`run_envelope()`). |

### `client.healthz()`

Probe `/v1/healthz`. Returns a `Healthz` dataclass (`status`, `gens`, `version`). Raises `BootingError` while the server is still pre-compiling gens, `CambiumConnectionError` if it can't be reached.

### Async parity

`client.run_async(...)` and `client.healthz_async()` mirror their sync siblings with identical signatures and exception trees. Use either path on the same `CambiumClient` instance — both pools live independently. `async with` cleans up both.

### Context manager

```python
# Sync
with CambiumClient(url=...) as client:
    ...

# Async
async with CambiumClient(url=...) as client:
    ...
```

Outside a context manager, call `client.close()` (sync) or `await client.aclose()` (async) explicitly.

## Errors

Every server failure surfaces as a `CambiumError` subclass keyed off the wire `error.kind` enum. Catch by subclass for fine-grained handling, or `CambiumError` as the umbrella:

| `error.kind` | Exception | When |
| -- | -- | -- |
| `unknown_gen` | `UnknownGenError` | Gen name not in catalog. |
| `unknown_method` | `UnknownMethodError` | Gen exists, method does not. |
| `input_invalid` | `InputInvalidError` | Malformed body, missing required fields, oversize. |
| `validation_failed` | `ValidationFailedError` | Schema validation exhausted after repair attempts. |
| `budget_exhausted` | `BudgetExhaustedError` | `BudgetExceededError` inside `runGen`. |
| `tool_dispatch_failed` | `ToolDispatchFailedError` | Unknown tool, action, or security violation. |
| `runner_error` | `RunnerError` (alias: `CambiumRunError`) | Other runtime failures. |
| `timeout` | `CambiumTimeoutError` | `--run-timeout` deadline missed. |
| `overloaded` | `OverloadedError` | `--max-inflight` cap hit; backoff and retry. |
| `booting` | `BootingError` | Server still pre-compiling at boot. |
| `not_found` | `NotFoundError` | Unknown HTTP route. |
| *(transport)* | `CambiumConnectionError` (alias: `CambiumNotFoundError`) | Server unreachable. |

Every exception carries `.kind: str`, `.run_id: str | None` (null on pre-dispatch errors), and `.details: dict | None`. Future server kinds we don't know about surface via the `CambiumError` base class with the real `.kind` populated rather than the request silently "succeeding."

```python
from cambium_client import (
    CambiumClient, BudgetExhaustedError, CambiumTimeoutError, OverloadedError,
)

with CambiumClient(url=...) as client:
    try:
        result = client.run("ResumeParser", "analyze", resume_text)
    except OverloadedError:
        # Back off + retry
        ...
    except (BudgetExhaustedError, CambiumTimeoutError) as e:
        # Surface to caller; e.run_id can be correlated with the on-disk trace
        log.warning("cambium failure: kind=%s run_id=%s", e.kind, e.run_id)
        raise
```

## Subprocess fallback (recipe)

`cambium-client` is pure HTTP — it does NOT bake in a subprocess fallback for `CAMBIUM_SERVE_URL` unset. Callers who want graceful degradation when the server isn't available can wire it themselves in ~5 lines:

```python
import os
from cambium_client import CambiumClient, CambiumConnectionError

def run_gen(gen: str, method: str, input_data):
    url = os.environ.get("CAMBIUM_SERVE_URL")
    if url:
        with CambiumClient(url=url) as c:
            return c.run(gen, method, input_data)
    # Fallback: shell out to `cambium run` (your existing wrapper),
    # or raise a clear "server not configured" error.
    raise RuntimeError("CAMBIUM_SERVE_URL is unset and no fallback configured")
```

## Migration from a subprocess wrapper

If you already have a `services/cambium.py` that wraps `subprocess.run(["cambium", "run", ...])` with `CambiumError` / `CambiumRunError` / `CambiumNotFoundError`, this client keeps those names compatible. Replace the subprocess `run()` body with a `CambiumClient(...).run()` call; the exception names propagate.

## Versioning

Wire-format pinning: `cambium-client` targets the server's `/v1/` routes. The constant `cambium_client.WIRE_VERSION` is `"v1"`. A future server `/v2/` is a separate client release (`cambium-client-v2`-style or major bump).

Adheres to [SemVer](https://semver.org/). The `error.kind` enum is closed in v1 — new kinds are a v2 break.

## Publishing (maintainer)

Manual flow, mirroring the runner package's npm flow:

```bash
cd packages/cambium-client-python

# 1. Bump src/cambium_client/_version.py.
# 2. Build the wheel.
python -m build

# 3. Gate: pre-publish-check builds in a fresh venv + smoke-imports
#    + asserts py.typed ships + asserts no stray tests/ in the wheel.
python scripts/pre_publish_check.py

# 4. Final check via twine.
python -m twine check dist/*

# 5. Smoke-test from TestPyPI first.
python -m twine upload --repository testpypi dist/*

# 6. Real PyPI.
python -m twine upload dist/*

# 7. Tag.
git tag cambium-client@v0.1.0
git push --tags
```

The `pre_publish_check.py` script is the analogue of the runner package's `scripts/pre-publish-check.mjs`: it validates the published *artifact* by building the wheel, installing it into a fresh venv (not the source tree), smoke-importing, and inspecting the wheel zip for stray test/cache files. Any failure exits non-zero.

## License

MIT. See `LICENSE`.
