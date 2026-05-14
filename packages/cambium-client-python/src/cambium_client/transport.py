"""URL → `httpx` transport configuration.

Pure config: parses a `cambium-client` URL into the pieces needed to
construct an `httpx.Client` / `httpx.AsyncClient`. The client layer
(slice 4) consumes these and instantiates the actual clients.

Accepted URL schemes:

| Scheme | base_url passed to httpx           | Explicit transport | Status |
| -- | -- | -- | -- |
| `http://...` | as-is                       | None (httpx default) | v1 |
| `https://...` | as-is                      | None                 | v1 |
| `tcp://host:port` | rewritten to `http://host:port` | None             | v1 (convenience) |
| `unix:///abs/path` | `http://localhost`        | `httpx.HTTPTransport(uds=path)` + async equiv | v1 |
| `pipe://name` | —                              | —                    | v1.1 (NotImplementedError) |

The `tcp://` form is convenience — Phase 1's CLI takes URIs in this
shape (`--bind tcp://127.0.0.1:9000`); accepting the same syntax on the
client side lets operators copy-paste between flags and config.

UDS uses `http://localhost` as the base URL because httpx still needs
*some* URL to construct requests against; the actual byte path is
governed by the transport's `uds=` argument, not the URL's host.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

import httpx


@dataclass(frozen=True)
class TransportConfig:
    """What an `httpx.Client(...)` constructor needs to talk to the server.

    `base_url` always goes to `httpx.Client(base_url=...)`. The two
    transport fields are passed to `transport=...` when non-None; both
    are None for plain HTTP/HTTPS/TCP (httpx picks its default
    transport in that case).
    """

    base_url: str
    transport_sync: httpx.HTTPTransport | None
    transport_async: httpx.AsyncHTTPTransport | None


def parse_url(url: str) -> TransportConfig:
    """Parse a `cambium-client` URL into transport config.

    Raises:
        ValueError: malformed URL (empty, missing scheme, missing host,
            unknown scheme, missing port for tcp://, non-absolute unix
            socket path).
        NotImplementedError: `pipe://` URLs (Windows named pipes;
            deferred to v1.1).
    """
    if not isinstance(url, str) or url == "":
        raise ValueError("CambiumClient(url=...) must be a non-empty string")

    parsed = urlparse(url)
    scheme = parsed.scheme.lower()

    if scheme in ("http", "https"):
        if not parsed.netloc:
            raise ValueError(f"Invalid Cambium URL '{url}': missing host.")
        return TransportConfig(
            base_url=_strip_trailing_slash(url),
            transport_sync=None,
            transport_async=None,
        )

    if scheme == "tcp":
        # tcp://host:port — rewrite to http://host:port. We REQUIRE a
        # port; this is the same loopback-friendly form `cambium serve
        # --bind tcp://...` uses on the server side.
        if not parsed.hostname:
            raise ValueError(f"Invalid Cambium URL '{url}': missing host.")
        if parsed.port is None:
            raise ValueError(
                f"Invalid Cambium URL '{url}': tcp:// requires an explicit port "
                "(e.g. tcp://127.0.0.1:9000)."
            )
        # `parsed.hostname` lowercases the host and drops brackets from
        # IPv6 forms; reapply the bracket convention for the rebuilt URL.
        host = parsed.hostname
        if ":" in host:  # IPv6
            host = f"[{host}]"
        return TransportConfig(
            base_url=f"http://{host}:{parsed.port}",
            transport_sync=None,
            transport_async=None,
        )

    if scheme == "unix":
        # unix:///abs/path — the path is in `parsed.path` (parsed.netloc
        # is empty for the proper three-slash form).
        if parsed.netloc:
            raise ValueError(
                f"Invalid Cambium URL '{url}': unix:// must use the three-slash "
                "form (unix:///abs/path)."
            )
        path = parsed.path
        if not path or not path.startswith("/"):
            raise ValueError(
                f"Invalid Cambium URL '{url}': unix:// requires an absolute path."
            )
        return TransportConfig(
            base_url="http://cambium-uds",  # httpx needs a host; transport ignores it
            transport_sync=httpx.HTTPTransport(uds=path),
            transport_async=httpx.AsyncHTTPTransport(uds=path),
        )

    if scheme == "pipe":
        raise NotImplementedError(
            "pipe:// (Windows named pipes) is deferred to cambium-client v1.1. "
            "Use tcp://127.0.0.1:<port> in the meantime."
        )

    raise ValueError(
        f"Invalid Cambium URL '{url}': unknown scheme '{scheme}'. "
        "Expected one of: http, https, tcp, unix, pipe."
    )


def _strip_trailing_slash(url: str) -> str:
    """Strip exactly one trailing slash off a base URL.

    Avoids `http://host//v1/run`-style double slashes when the caller
    passed `http://host/` and request paths start with `/v1/...`.
    """
    return url[:-1] if url.endswith("/") else url
