# cambium-client

Python client for [Cambium](https://github.com/redwood-labs-ai/cambium) serve mode (RED-360). Speaks the v1 HTTP wire format — `pip install cambium-client`, point at a running `cambium serve` process, call gens.

The transport for non-Node hosts (FastAPI, Django, Flask, Go-via-HTTP, Elixir, anything that needs warm Cambium without a Node bridge).

## Status

**0.1.0 — under construction.** Package scaffolded; runtime surface lands across the next few commits. The wire format it targets (v1) is locked.

## Install

```bash
pip install cambium-client
```

Requires Python 3.10+. Single runtime dependency: `httpx>=0.27.2`.

## Use

(API stub — full surface lands in subsequent commits.)

```python
from cambium_client import CambiumClient

with CambiumClient(url="http://cambium-runner:9000") as client:
    output = client.run("ResumeParser", "analyze", resume_text)

# Or async:
async with CambiumClient(url="http://cambium-runner:9000") as client:
    output = await client.run_async("ResumeParser", "analyze", resume_text)
```

## Transports

| Scheme | v1 support | Notes |
| -- | -- | -- |
| `http://` / `https://` | ✅ | Standard `httpx`. |
| `tcp://host:port` | ✅ | Convenience form; rewritten to `http://`. |
| `unix:///abs/path` | ✅ | `httpx` UDS transport. Mac/Linux. |
| `pipe://name` | ❌ (v1.1) | Windows named pipes — `NotImplementedError` until v1.1. |

## License

MIT. See `LICENSE`.
