"""Transport URL-parsing tests.

Pure config — no httpx network calls, no real server. UDS transports
are constructed but not connected to; UDS-against-real-server lives in
slice 7.
"""

from __future__ import annotations

import httpx
import pytest

from cambium_client.transport import TransportConfig, parse_url


# ── http / https ─────────────────────────────────────────────────────


def test_http_passes_through() -> None:
    cfg = parse_url("http://cambium-runner:9000")
    assert cfg.base_url == "http://cambium-runner:9000"
    assert cfg.transport_sync is None
    assert cfg.transport_async is None


def test_https_passes_through() -> None:
    cfg = parse_url("https://api.example.com")
    assert cfg.base_url == "https://api.example.com"


def test_http_trailing_slash_stripped() -> None:
    """Avoids `http://host//v1/run` from concatenation."""
    cfg = parse_url("http://localhost:9000/")
    assert cfg.base_url == "http://localhost:9000"


def test_http_missing_host_rejected() -> None:
    with pytest.raises(ValueError, match="missing host"):
        parse_url("http://")


# ── tcp:// (convenience form, rewritten to http://) ──────────────────


def test_tcp_rewritten_to_http() -> None:
    cfg = parse_url("tcp://127.0.0.1:9000")
    assert cfg.base_url == "http://127.0.0.1:9000"
    assert cfg.transport_sync is None
    assert cfg.transport_async is None


def test_tcp_ipv6_bracket_preserved() -> None:
    cfg = parse_url("tcp://[::1]:9000")
    assert cfg.base_url == "http://[::1]:9000"


def test_tcp_requires_explicit_port() -> None:
    with pytest.raises(ValueError, match="requires an explicit port"):
        parse_url("tcp://localhost")


def test_tcp_missing_host_rejected() -> None:
    with pytest.raises(ValueError, match="missing host"):
        parse_url("tcp://:9000")


# ── unix:// ──────────────────────────────────────────────────────────


def test_unix_returns_uds_transport_pair() -> None:
    cfg = parse_url("unix:///tmp/cambium.sock")
    assert cfg.base_url == "http://cambium-uds"
    assert isinstance(cfg.transport_sync, httpx.HTTPTransport)
    assert isinstance(cfg.transport_async, httpx.AsyncHTTPTransport)


def test_unix_empty_path_rejected() -> None:
    """`unix://` (no path) hits the absolute-path guard."""
    with pytest.raises(ValueError, match="absolute path"):
        parse_url("unix://")


def test_unix_requires_three_slash_form() -> None:
    """`unix://host/path` is malformed — operators commonly mistype it.

    urlparse pulls the segment between `://` and the next `/` into the
    netloc, so any non-empty netloc on a unix:// URL means the operator
    skipped a slash. Flag it with a message that names the right form.
    """
    with pytest.raises(ValueError, match="three-slash form"):
        parse_url("unix://relative/path")


# ── pipe:// (deferred to v1.1) ───────────────────────────────────────


def test_pipe_raises_not_implemented() -> None:
    with pytest.raises(NotImplementedError, match=r"v1\.1"):
        parse_url("pipe://cambium")


def test_pipe_message_points_at_tcp_workaround() -> None:
    """Operators who hit the not-implemented should see the workaround."""
    with pytest.raises(NotImplementedError, match="tcp://127.0.0.1"):
        parse_url("pipe://cambium")


# ── scheme dispatch ──────────────────────────────────────────────────


def test_empty_string_rejected() -> None:
    with pytest.raises(ValueError, match="non-empty string"):
        parse_url("")


def test_unknown_scheme_rejected() -> None:
    with pytest.raises(ValueError, match="unknown scheme 'ftp'"):
        parse_url("ftp://example.com")


def test_no_scheme_rejected() -> None:
    """Bare `localhost:9000` doesn't have a scheme — flag it clearly."""
    with pytest.raises(ValueError, match="unknown scheme"):
        parse_url("localhost:9000")


# ── TransportConfig is a frozen dataclass ────────────────────────────


def test_transport_config_is_frozen() -> None:
    cfg = parse_url("http://localhost:9000")
    with pytest.raises((AttributeError, TypeError)):
        cfg.base_url = "http://other"  # type: ignore[misc]


def test_transport_config_equality() -> None:
    """Useful for tests that want to assert two parses produce the same config."""
    a = parse_url("http://localhost:9000")
    b = parse_url("http://localhost:9000")
    assert a == b


# ── httpx.Client can be constructed from the parsed config ───────────


def test_http_config_constructs_httpx_client() -> None:
    """Smoke test: the parsed config is actually consumable by httpx."""
    cfg = parse_url("http://localhost:9000")
    with httpx.Client(base_url=cfg.base_url, transport=cfg.transport_sync, timeout=1.0) as c:
        assert c.base_url == httpx.URL("http://localhost:9000")


def test_unix_config_constructs_httpx_client() -> None:
    """UDS config also constructs cleanly (we don't actually connect)."""
    cfg = parse_url("unix:///tmp/nonexistent.sock")
    with httpx.Client(base_url=cfg.base_url, transport=cfg.transport_sync, timeout=1.0) as c:
        # The Client constructs; connecting would fail (no socket) but
        # we're just verifying the construction path.
        assert c.base_url == httpx.URL("http://cambium-uds")
