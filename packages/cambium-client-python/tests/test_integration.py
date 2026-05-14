"""End-to-end tests against a real spawned `cambium serve`.

This is the wire-format acid test — first time the Python client talks
to the actual server. Any wire-format gap that wasn't caught by the
MockTransport unit tests surfaces here.

Slowest tests in the suite (subprocess boot + healthz probe ~1s per
test). Skipped automatically if the runner package's `dist/` isn't
built (see `conftest.runner_bin`).
"""

from __future__ import annotations

import pytest

from cambium_client import (
    BootingError,
    CambiumClient,
    CambiumConnectionError,
    UnknownGenError,
    UnknownMethodError,
)


# ── healthz round-trip ───────────────────────────────────────────────


def test_healthz_returns_real_catalog(serve_url: str) -> None:
    """The server actually serves the tmp workspace's catalog."""
    with CambiumClient(url=serve_url) as client:
        h = client.healthz()
    assert h.status == "ok"
    assert h.gens == ["TinyGen"]
    assert h.version == "v1"


async def test_healthz_async_works_end_to_end(serve_url: str) -> None:
    async with CambiumClient(url=serve_url) as client:
        h = await client.healthz_async()
    assert h.gens == ["TinyGen"]


# ── run round-trip (mock provider) ───────────────────────────────────


def test_run_round_trips_through_real_server(serve_url: str) -> None:
    """Full request/response cycle through serve.ts + runGenFromIr.

    The runner is in mock mode (`CAMBIUM_ALLOW_MOCK=1`), so the gen's
    `generate` step calls `mockGenerate` rather than a real model. Mock
    output validates against the permissive `AnalysisReport` schema in
    the tmp workspace's contracts.ts. Success path returns the bare
    output dict.
    """
    with CambiumClient(url=serve_url) as client:
        out = client.run("TinyGen", "analyze", "input doc with 42 ms in it")
    # mockGenerate(prompt, schema) emits `{summary, metrics, key_facts}`
    # regardless of the schema, parsing `<num> ms` patterns from the
    # prompt into `metrics.latency_ms_samples`. We just assert a few
    # structural anchors so the test doesn't pin to the mock's exact
    # wording (which could shift in a future runner change).
    assert isinstance(out, dict)
    assert "summary" in out
    assert "metrics" in out


async def test_run_async_round_trips_through_real_server(serve_url: str) -> None:
    async with CambiumClient(url=serve_url) as client:
        out = await client.run_async("TinyGen", "analyze", "another doc")
    assert isinstance(out, dict)
    assert "summary" in out


# ── error paths against real server ──────────────────────────────────


def test_unknown_gen_against_real_server(serve_url: str) -> None:
    """The server's unknown_gen response is what the client expects."""
    with CambiumClient(url=serve_url) as client:
        with pytest.raises(UnknownGenError) as info:
            client.run("GhostGen", "analyze", "x")
    assert info.value.kind == "unknown_gen"
    assert info.value.run_id is None
    assert info.value.details is not None
    assert "TinyGen" in info.value.details.get("available", [])


def test_unknown_method_against_real_server(serve_url: str) -> None:
    with CambiumClient(url=serve_url) as client:
        with pytest.raises(UnknownMethodError) as info:
            client.run("TinyGen", "no_such_method", "x")
    assert info.value.kind == "unknown_method"
    # Acceptance: details.available lists the gen's real methods.
    assert "analyze" in info.value.details["available"]  # type: ignore[index]


# ── connection failure against an unreachable port ───────────────────


def test_unreachable_port_raises_cambium_connection_error() -> None:
    """No fixture — point at a port that's almost-certainly closed."""
    # Port 1 is reserved + universally refused (or filtered) on Mac/Linux.
    client = CambiumClient(url="http://127.0.0.1:1", timeout=2.0)
    try:
        with pytest.raises(CambiumConnectionError):
            client.run("X", "y", "z")
    finally:
        client.close()


# ── include_trace round-trips through the real runner ────────────────


def test_run_with_include_trace_sends_flag_to_real_server(serve_url: str) -> None:
    """The flag forwards; the response shape stays bare-output for the caller.

    The trace itself lives in the server's response body when
    `include_trace=true`, but the v1 `run()` API returns just the
    output. We're verifying the flag doesn't break the round-trip,
    not asserting trace shape (the `run_envelope()` follow-up will
    surface it programmatically).
    """
    with CambiumClient(url=serve_url) as client:
        out = client.run("TinyGen", "analyze", "x", include_trace=True)
    assert isinstance(out, dict)
