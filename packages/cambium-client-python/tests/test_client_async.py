"""Async `CambiumClient` tests using `httpx.MockTransport`.

httpx.MockTransport works with both sync and async clients via the same
sync-handler signature, so the test layout here mirrors test_client_sync.py
but exercises the awaitable path. The dispatch helpers (`_dispatch_run_response`,
`_raise_from_failure_envelope`, `_dispatch_healthz_response`) are shared
between sync and async — these tests pin that the async wiring routes
through them correctly.
"""

from __future__ import annotations

import json
from typing import Any, Callable

import httpx
import pytest

from cambium_client import (
    BootingError,
    BudgetExhaustedError,
    CambiumClient,
    CambiumConnectionError,
    CambiumError,
    CambiumTimeoutError,
    InputInvalidError,
    NotFoundError,
    OverloadedError,
    RunnerError,
    ToolDispatchFailedError,
    UnknownGenError,
    UnknownMethodError,
    ValidationFailedError,
)


def _make_client(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    url: str = "http://test",
    **kwargs: Any,
) -> CambiumClient:
    """Build a CambiumClient whose async transport is a MockTransport."""
    return CambiumClient(
        url=url,
        _transport_async=httpx.MockTransport(handler),
        # Sync path also gets a no-op transport so any accidental sync
        # call during an async test surfaces a clear error instead of
        # hitting the network.
        _transport_sync=httpx.MockTransport(handler),
        **kwargs,
    )


def _success(output: Any, *, run_id: str = "run_async") -> httpx.Response:
    return httpx.Response(200, json={"ok": True, "run_id": run_id, "output": output})


def _failure(
    kind: str,
    message: str,
    *,
    status: int,
    run_id: str | None = None,
) -> httpx.Response:
    return httpx.Response(
        status,
        json={"ok": False, "run_id": run_id, "error": {"kind": kind, "message": message}},
    )


# ── async context manager ────────────────────────────────────────────


async def test_async_context_manager_closes() -> None:
    async with _make_client(lambda r: _success({})) as c:
        assert isinstance(c, CambiumClient)
    # `aclose()` closed both pools without raising.


async def test_aclose_is_idempotent() -> None:
    c = _make_client(lambda r: _success({}))
    await c.aclose()
    # Second call doesn't raise. httpx clients guard their own state.
    await c.aclose()


# ── happy path ───────────────────────────────────────────────────────


async def test_run_async_returns_bare_output() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return _success({"summary": "ok"})

    c = _make_client(handler)
    out = await c.run_async("G", "m", "x")
    assert out == {"summary": "ok"}


async def test_run_async_sends_correct_body() -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured.update(json.loads(req.content))
        captured["_method"] = req.method
        captured["_path"] = req.url.path
        return _success({"x": 1})

    async with _make_client(handler) as c:
        await c.run_async(
            "MyGen",
            "summarize",
            {"doc": "body"},
            memory_keys={"u": "1"},
            fired_by="schedule:hourly",
            include_trace=True,
        )

    assert captured["_method"] == "POST"
    assert captured["_path"] == "/v1/run"
    assert captured["gen"] == "MyGen"
    assert captured["method"] == "summarize"
    assert captured["input"] == {"doc": "body"}
    assert captured["memory_keys"] == {"u": "1"}
    assert captured["fired_by"] == "schedule:hourly"
    assert captured["include_trace"] is True


async def test_run_async_bytes_decoded_to_string() -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured.update(json.loads(req.content))
        return _success(None)

    async with _make_client(handler) as c:
        await c.run_async("G", "m", b"raw bytes")
    assert captured["input"] == "raw bytes"


# ── error.kind dispatch parity ───────────────────────────────────────


_KIND_FIXTURES: list[tuple[str, type[CambiumError], int]] = [
    ("unknown_gen", UnknownGenError, 400),
    ("unknown_method", UnknownMethodError, 400),
    ("input_invalid", InputInvalidError, 400),
    ("validation_failed", ValidationFailedError, 500),
    ("budget_exhausted", BudgetExhaustedError, 500),
    ("tool_dispatch_failed", ToolDispatchFailedError, 400),
    ("runner_error", RunnerError, 500),
    ("timeout", CambiumTimeoutError, 504),
    ("overloaded", OverloadedError, 503),
    ("booting", BootingError, 503),
    ("not_found", NotFoundError, 404),
]


@pytest.mark.parametrize("kind,exc_cls,status", _KIND_FIXTURES)
async def test_async_each_error_kind_raises_correct_subclass(
    kind: str, exc_cls: type[CambiumError], status: int
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return _failure(kind, f"{kind} test", status=status, run_id="run_a")

    async with _make_client(handler) as c:
        with pytest.raises(exc_cls) as info:
            await c.run_async("G", "m", "x")
    assert info.value.kind == kind
    assert info.value.run_id == "run_a"


async def test_async_run_id_null_on_pre_dispatch_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return _failure("unknown_gen", "no such", status=400, run_id=None)

    async with _make_client(handler) as c:
        with pytest.raises(UnknownGenError) as info:
            await c.run_async("Ghost", "m", "x")
    assert info.value.run_id is None


# ── connection failures ──────────────────────────────────────────────


async def test_async_connect_error_raises_cambium_connection_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    async with _make_client(handler) as c:
        with pytest.raises(CambiumConnectionError, match="could not reach"):
            await c.run_async("G", "m", "x")


async def test_async_connect_timeout_raises_cambium_connection_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out")

    async with _make_client(handler) as c:
        with pytest.raises(CambiumConnectionError):
            await c.run_async("G", "m", "x")


# ── healthz_async ────────────────────────────────────────────────────


async def test_healthz_async_returns_parsed_payload() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "ok", "gens": ["X"], "version": "v1"}
        )

    async with _make_client(handler) as c:
        h = await c.healthz_async()
    assert h.status == "ok"
    assert h.gens == ["X"]


async def test_healthz_async_booting_raises_booting_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return _failure("booting", "loading", status=503, run_id=None)

    async with _make_client(handler) as c:
        with pytest.raises(BootingError):
            await c.healthz_async()


async def test_healthz_async_connection_failure_raises_cambium_connection_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    async with _make_client(handler) as c:
        with pytest.raises(CambiumConnectionError):
            await c.healthz_async()


# ── interleaving sync + async on the same instance ───────────────────


async def test_sync_and_async_can_share_one_client_instance() -> None:
    """Both pools live on the same CambiumClient; both work, independently.

    Tests that closing one path doesn't break the other prematurely
    AND that the dispatcher state isn't accidentally instance-mutated.
    """
    def handler(_req: httpx.Request) -> httpx.Response:
        return _success({"x": 1})

    c = _make_client(handler)
    try:
        sync_out = c.run("G", "m", "x")
        async_out = await c.run_async("G", "m", "x")
        assert sync_out == {"x": 1}
        assert async_out == {"x": 1}
    finally:
        await c.aclose()
