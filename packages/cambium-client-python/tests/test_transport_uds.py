"""Integration tests for Unix-domain-socket transport.

Spawns `cambium serve --bind unix:///tmp/cm-*.sock` and exercises the
client against it. Skipped automatically on Windows; `pipe://` is the
v1.1 follow-up for Windows named pipes.

These tests are the only place UDS is actually carried by a real
socket — slices 3 + 4 covered URL parsing and construction with
MockTransport. If httpx's UDS support ever shifts, the smoke-test
fails here before it bites a downstream caller.
"""

from __future__ import annotations

import pytest

from cambium_client import CambiumClient, UnknownGenError


def test_healthz_round_trips_over_uds(serve_url_uds: str) -> None:
    """Confirms the URL parses to a UDS transport and reaches the server."""
    with CambiumClient(url=serve_url_uds) as client:
        h = client.healthz()
    assert h.status == "ok"
    assert h.gens == ["TinyGen"]


async def test_healthz_async_round_trips_over_uds(serve_url_uds: str) -> None:
    async with CambiumClient(url=serve_url_uds) as client:
        h = await client.healthz_async()
    assert h.gens == ["TinyGen"]


def test_run_round_trips_over_uds(serve_url_uds: str) -> None:
    """Mock-provider round-trip over UDS — full dispatch path."""
    with CambiumClient(url=serve_url_uds) as client:
        out = client.run("TinyGen", "analyze", "doc")
    assert isinstance(out, dict)
    assert "summary" in out


async def test_run_async_round_trips_over_uds(serve_url_uds: str) -> None:
    async with CambiumClient(url=serve_url_uds) as client:
        out = await client.run_async("TinyGen", "analyze", "doc")
    assert isinstance(out, dict)
    assert "summary" in out


def test_error_kinds_propagate_over_uds(serve_url_uds: str) -> None:
    """Wire format is the same regardless of transport — error path proves it."""
    with CambiumClient(url=serve_url_uds) as client:
        with pytest.raises(UnknownGenError) as info:
            client.run("Ghost", "analyze", "x")
    assert info.value.kind == "unknown_gen"
    assert info.value.run_id is None
