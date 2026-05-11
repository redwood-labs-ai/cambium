"""Wire-format dataclass tests.

Pure-Python — no httpx, no real server. Verifies the
`RunRequest.to_dict` and `*.from_dict` shapes match the JSON the server
emits/expects per `docs/GenDSL Docs/C - Serve Mode.md`.

The kind-coverage test is the load-bearing one: it pins our exception
table to the server's closed enum. If a kind gets added to `serve.ts`
without a corresponding subclass here, this test fails the build.
"""

from __future__ import annotations

import re
from pathlib import Path

from cambium_client.errors import _KIND_TO_EXC
from cambium_client.wire import (
    WIRE_VERSION,
    ErrorEnvelope,
    Healthz,
    RunFailure,
    RunRequest,
    RunSuccess,
)

# Repo root, derived from this file's location. tests/test_wire.py →
# .../packages/cambium-client-python/tests → up 3 = workspace root.
REPO_ROOT = Path(__file__).resolve().parents[3]
SERVE_TS = REPO_ROOT / "packages" / "cambium-runner" / "src" / "serve" / "serve.ts"


# ── WIRE_VERSION ─────────────────────────────────────────────────────


def test_wire_version_is_v1() -> None:
    """v1 is locked from the first release; v2 would be a separate channel."""
    assert WIRE_VERSION == "v1"


# ── RunRequest.to_dict ───────────────────────────────────────────────


def test_run_request_minimal_body() -> None:
    req = RunRequest(gen="ResumeParser", method="analyze", input="hello")
    assert req.to_dict() == {
        "gen": "ResumeParser",
        "method": "analyze",
        "input": "hello",
    }


def test_run_request_includes_optional_fields_only_when_set() -> None:
    req = RunRequest(
        gen="X",
        method="y",
        input={"foo": "bar"},
        memory_keys={"user_id": "abc"},
        fired_by="schedule:daily",
        include_trace=True,
    )
    body = req.to_dict()
    assert body["memory_keys"] == {"user_id": "abc"}
    assert body["fired_by"] == "schedule:daily"
    assert body["include_trace"] is True


def test_run_request_omits_include_trace_when_false() -> None:
    """`include_trace: false` is the default — don't serialize it (smaller payload)."""
    req = RunRequest(gen="X", method="y", input="z")
    assert "include_trace" not in req.to_dict()


def test_run_request_omits_memory_keys_when_none() -> None:
    req = RunRequest(gen="X", method="y", input="z")
    assert "memory_keys" not in req.to_dict()


# ── RunSuccess.from_dict ─────────────────────────────────────────────


def test_run_success_minimal() -> None:
    s = RunSuccess.from_dict({"run_id": "run_x", "output": {"a": 1}})
    assert s.run_id == "run_x"
    assert s.output == {"a": 1}
    assert s.trace is None


def test_run_success_with_inline_trace() -> None:
    s = RunSuccess.from_dict(
        {"run_id": "r", "output": "ok", "trace": {"steps": []}}
    )
    assert s.trace == {"steps": []}


def test_run_success_run_id_null_does_not_become_literal_None() -> None:
    """Regression guard: `str(None) == "None"` would silently corrupt
    a null `run_id` into the literal string `"None"`. The server's
    response construction `run_id: result.runId ?? null` leaves the
    null path open even on success, so the parser must handle it.
    """
    s = RunSuccess.from_dict({"run_id": None, "output": {"x": 1}})
    assert s.run_id is None
    assert s.output == {"x": 1}


# ── RunFailure.from_dict ─────────────────────────────────────────────


def test_run_failure_with_run_id() -> None:
    f = RunFailure.from_dict(
        {
            "run_id": "run_x",
            "error": {"kind": "validation_failed", "message": "nope"},
        }
    )
    assert f.run_id == "run_x"
    assert f.error.kind == "validation_failed"
    assert f.error.message == "nope"
    assert f.error.details is None


def test_run_failure_run_id_null_for_pre_dispatch_errors() -> None:
    """The server emits `run_id: null` on pre-dispatch errors. Python sees `None`."""
    f = RunFailure.from_dict(
        {
            "run_id": None,
            "error": {"kind": "unknown_gen", "message": "no such gen"},
        }
    )
    assert f.run_id is None


def test_run_failure_carries_error_details() -> None:
    f = RunFailure.from_dict(
        {
            "run_id": None,
            "error": {
                "kind": "unknown_gen",
                "message": "...",
                "details": {"available": ["A", "B"]},
            },
        }
    )
    assert f.error.details == {"available": ["A", "B"]}


# ── Healthz.from_dict ────────────────────────────────────────────────


def test_healthz_round_trip() -> None:
    h = Healthz.from_dict({"status": "ok", "gens": ["A", "B"], "version": "v1"})
    assert h.status == "ok"
    assert h.gens == ["A", "B"]
    assert h.version == "v1"


def test_healthz_defaults_when_fields_missing() -> None:
    """Permissive defaults — additive fields don't break parsing."""
    h = Healthz.from_dict({})
    assert h.status == ""
    assert h.gens == []
    assert h.version == WIRE_VERSION


# ── ErrorEnvelope ────────────────────────────────────────────────────


def test_error_envelope_missing_message_defaults_to_empty() -> None:
    """Server should always send `message`, but defend against a missing one."""
    env = ErrorEnvelope.from_dict({"kind": "runner_error"})
    assert env.kind == "runner_error"
    assert env.message == ""


# ── kind coverage: serve.ts is the authoritative source ──────────────


def _extract_kinds_from_serve_ts() -> set[str]:
    """Parse the `ErrorKind` union from serve.ts.

    Looks for:
        export type ErrorKind =
          | 'unknown_gen'
          | 'unknown_method'
          | ...
    """
    if not SERVE_TS.exists():
        # Repo layout shouldn't change but if it does the test should
        # surface a clear failure rather than silently passing.
        raise AssertionError(
            f"serve.ts not found at {SERVE_TS} — has the runner package moved?"
        )
    text = SERVE_TS.read_text(encoding="utf-8")
    match = re.search(
        r"export\s+type\s+ErrorKind\s*=\s*((?:\s*\|\s*'[a-z_]+')+)\s*;",
        text,
    )
    assert match, "ErrorKind union not found in serve.ts"
    return set(re.findall(r"'([a-z_]+)'", match.group(1)))


def test_kind_to_exc_covers_every_error_kind_in_serve_ts() -> None:
    """Cross-file invariant: every kind the server can emit has a Python exception.

    If a new kind is added to `serve.ts`'s ErrorKind union, this test
    fails until the Python side adds the corresponding subclass and
    table entry.
    """
    server_kinds = _extract_kinds_from_serve_ts()
    client_kinds = set(_KIND_TO_EXC.keys())
    missing_from_client = server_kinds - client_kinds
    extra_in_client = client_kinds - server_kinds
    assert not missing_from_client, (
        f"serve.ts emits kinds the Python client doesn't know about: "
        f"{sorted(missing_from_client)}. Add subclasses in errors.py and "
        f"entries in _KIND_TO_EXC."
    )
    assert not extra_in_client, (
        f"Python client has subclasses for kinds the server never emits: "
        f"{sorted(extra_in_client)}. Either the server dropped them or the "
        f"client over-claims coverage."
    )
