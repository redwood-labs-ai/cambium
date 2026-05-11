"""Sync `CambiumClient` tests using `httpx.MockTransport`.

No real `cambium serve` here — slice 6 does that. This pass exercises
the wire-format + dispatch logic against fabricated responses, one per
error.kind plus happy paths + transport failures.
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
    CambiumNotFoundError,
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


# ── helpers ──────────────────────────────────────────────────────────


def _make_client(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    url: str = "http://test",
    **kwargs: Any,
) -> CambiumClient:
    """Build a CambiumClient whose sync transport is a MockTransport."""
    return CambiumClient(
        url=url,
        _transport_sync=httpx.MockTransport(handler),
        **kwargs,
    )


def _success(output: Any, *, run_id: str = "run_test", trace: dict | None = None) -> httpx.Response:
    body: dict[str, Any] = {"ok": True, "run_id": run_id, "output": output}
    if trace is not None:
        body["trace"] = trace
    return httpx.Response(200, json=body)


def _failure(
    kind: str,
    message: str,
    *,
    status: int,
    run_id: str | None = None,
    details: dict | None = None,
) -> httpx.Response:
    err: dict[str, Any] = {"kind": kind, "message": message}
    if details is not None:
        err["details"] = details
    return httpx.Response(status, json={"ok": False, "run_id": run_id, "error": err})


# ── construction ─────────────────────────────────────────────────────


def test_constructs_and_reprs_cleanly() -> None:
    c = _make_client(lambda r: _success({}))
    assert "http://test" in repr(c)
    assert "timeout=30" in repr(c)


def test_context_manager_closes() -> None:
    with _make_client(lambda r: _success({})) as c:
        assert isinstance(c, CambiumClient)
    # No explicit assertion — if close() blew up, the with-block would
    # surface it. (httpx.Client.close() is idempotent.)


def test_probe_true_calls_healthz_at_construction() -> None:
    calls: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req)
        return httpx.Response(200, json={"status": "ok", "gens": ["A"], "version": "v1"})

    _make_client(handler, probe=True)
    assert len(calls) == 1
    assert calls[0].url.path == "/v1/healthz"


def test_probe_true_raises_on_unreachable() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with pytest.raises(CambiumConnectionError, match="could not reach"):
        _make_client(handler, probe=True)


# ── happy path ───────────────────────────────────────────────────────


def test_run_happy_path_returns_bare_output() -> None:
    """Per the API decision: client.run() returns just the output dict."""
    def handler(_req: httpx.Request) -> httpx.Response:
        return _success({"summary": "ok", "key_facts": []}, run_id="run_xyz")

    c = _make_client(handler)
    out = c.run("MyGen", "analyze", "input string")
    assert out == {"summary": "ok", "key_facts": []}


def test_run_sends_correct_body() -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured.update(json.loads(req.content))
        captured["_url"] = str(req.url)
        captured["_method"] = req.method
        return _success({"x": 1})

    c = _make_client(handler)
    c.run(
        "MyGen",
        "analyze",
        {"doc": "hello"},
        memory_keys={"user_id": "abc"},
        fired_by="schedule:daily",
        include_trace=True,
    )

    assert captured["_method"] == "POST"
    assert captured["_url"].endswith("/v1/run")
    assert captured["gen"] == "MyGen"
    assert captured["method"] == "analyze"
    assert captured["input"] == {"doc": "hello"}
    assert captured["memory_keys"] == {"user_id": "abc"}
    assert captured["fired_by"] == "schedule:daily"
    assert captured["include_trace"] is True


def test_run_strings_pass_through_unchanged() -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured.update(json.loads(req.content))
        return _success(None)

    _make_client(handler).run("G", "m", "raw string body")
    assert captured["input"] == "raw string body"


def test_run_bytes_decoded_to_utf8_string() -> None:
    """Per the ticket: `bytes` for pre-serialised payloads. Decode to str."""
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured.update(json.loads(req.content))
        return _success(None)

    _make_client(handler).run("G", "m", b'{"pre": "encoded"}')
    assert captured["input"] == '{"pre": "encoded"}'


def test_run_omits_optional_fields_when_unset() -> None:
    captured: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured.update(json.loads(req.content))
        return _success(None)

    _make_client(handler).run("G", "m", "x")
    assert "memory_keys" not in captured
    assert "fired_by" not in captured
    assert "include_trace" not in captured


def test_run_include_trace_surfaces_trace_through_to_server() -> None:
    """The trace is the server's responsibility to return; client just forwards the flag."""
    captured_body: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        captured_body.update(json.loads(req.content))
        return _success({"x": 1}, trace={"steps": [{"id": "s1"}]})

    out = _make_client(handler).run("G", "m", "x", include_trace=True)
    # Output is returned bare; trace isn't surfaced as a return value
    # (it lives on disk + in the success envelope which the dispatcher
    # discards). That's a deliberate v1 choice; opens a follow-up
    # ticket if a real user wants programmatic access.
    assert out == {"x": 1}
    assert captured_body["include_trace"] is True


# ── error.kind → exception mapping ───────────────────────────────────


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
def test_each_error_kind_raises_correct_subclass(
    kind: str, exc_cls: type[CambiumError], status: int
) -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return _failure(kind, f"{kind} test message", status=status, run_id="run_x")

    with pytest.raises(exc_cls) as info:
        _make_client(handler).run("G", "m", "x")
    assert info.value.kind == kind
    assert info.value.run_id == "run_x"
    assert kind in str(info.value)


def test_run_id_null_on_pre_dispatch_error() -> None:
    """Pre-dispatch errors carry run_id=None on the exception."""
    def handler(_req: httpx.Request) -> httpx.Response:
        return _failure("unknown_gen", "no such gen", status=400, run_id=None)

    with pytest.raises(UnknownGenError) as info:
        _make_client(handler).run("Ghost", "m", "x")
    assert info.value.run_id is None


def test_error_details_propagate_to_exception() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return _failure(
            "unknown_gen", "...", status=400, run_id=None,
            details={"available": ["A", "B"]},
        )

    with pytest.raises(UnknownGenError) as info:
        _make_client(handler).run("Ghost", "m", "x")
    assert info.value.details == {"available": ["A", "B"]}


def test_unknown_server_kind_falls_back_to_base_error() -> None:
    """Future server kinds we don't know about surface via CambiumError."""
    def handler(_req: httpx.Request) -> httpx.Response:
        return _failure("brand_new_v2_kind", "new", status=500, run_id="r")

    with pytest.raises(CambiumError) as info:
        _make_client(handler).run("G", "m", "x")
    # NOT a subclass — the base class carries the unknown kind directly.
    assert type(info.value) is CambiumError
    assert info.value.kind == "brand_new_v2_kind"


# ── connection failures ──────────────────────────────────────────────


def test_connect_error_raises_cambium_connection_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    with pytest.raises(CambiumConnectionError, match="could not reach"):
        _make_client(handler).run("G", "m", "x")


def test_connect_error_caught_via_back_compat_alias() -> None:
    """`except CambiumNotFoundError` works because it's the same class."""
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    with pytest.raises(CambiumNotFoundError):
        _make_client(handler).run("G", "m", "x")


def test_connect_timeout_raises_cambium_connection_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out connecting")

    with pytest.raises(CambiumConnectionError):
        _make_client(handler).run("G", "m", "x")


# ── healthz ──────────────────────────────────────────────────────────


def test_healthz_returns_parsed_payload() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json={"status": "ok", "gens": ["A", "B"], "version": "v1"}
        )

    h = _make_client(handler).healthz()
    assert h.status == "ok"
    assert h.gens == ["A", "B"]
    assert h.version == "v1"


def test_healthz_booting_raises_booting_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        return _failure("booting", "loading gens", status=503, run_id=None)

    with pytest.raises(BootingError):
        _make_client(handler).healthz()


def test_healthz_connection_failure_raises_cambium_connection_error() -> None:
    def handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    with pytest.raises(CambiumConnectionError):
        _make_client(handler).healthz()


# ── malformed responses ──────────────────────────────────────────────


def test_non_json_response_raises_runner_error() -> None:
    """If something strips JSON content-type (reverse proxy?), we still raise structurally."""
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(500, content=b"<html>500 Internal Server Error</html>")

    with pytest.raises(RunnerError, match="non-JSON"):
        _make_client(handler).run("G", "m", "x")


def test_ok_false_without_error_envelope_still_raises_structurally() -> None:
    """Defensive — should never happen, but surface a useful error if it does."""
    def handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"ok": False})  # no `error` key

    with pytest.raises(RunnerError, match="without a Cambium failure envelope"):
        _make_client(handler).run("G", "m", "x")
