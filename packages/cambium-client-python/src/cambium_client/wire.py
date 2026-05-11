"""Wire-format dataclasses for the v1 HTTP surface.

Mirrors `packages/cambium-runner/src/serve/serve.ts`. This module is the
single point where the Python client knows the JSON shape — tests
against the runner's actual emissions guard it.

Frozen dataclasses chosen over Pydantic to keep the runtime dependency
footprint to `httpx` only. Callers who want richer modeling can adapt
to their own Pydantic types trivially from a plain dict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

#: Wire-format version. Matches the `/v1/` prefix on every route.
#: Bumped to "v2" if/when a breaking response change ships.
WIRE_VERSION = "v1"


# ── request ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class RunRequest:
    """Body of `POST /v1/run`.

    `input` accepts str | dict | list | bytes:
    - str / bytes pass through (bytes for pre-serialised payloads).
    - dict / list are JSON-encoded by the client before send.

    `memory_keys` is the typed-dict form; the client converts to the
    list-of-"name=value" strings the runner expects when serialising.
    """

    gen: str
    method: str
    input: Any
    memory_keys: dict[str, str] | None = None
    fired_by: str | None = None
    include_trace: bool = False

    def to_dict(self) -> dict[str, Any]:
        """Render as the JSON object the server expects.

        `input` is left as-is — the client's serializer handles
        dict/list/str/bytes uniformly when writing the request body.
        `memory_keys` stays as a dict; the client converts to the
        runner's "name=value" string form at dispatch time.
        """
        body: dict[str, Any] = {
            "gen": self.gen,
            "method": self.method,
            "input": self.input,
        }
        if self.memory_keys is not None:
            body["memory_keys"] = dict(self.memory_keys)
        if self.fired_by is not None:
            body["fired_by"] = self.fired_by
        if self.include_trace:
            body["include_trace"] = True
        return body


# ── response: success ────────────────────────────────────────────────


@dataclass(frozen=True)
class RunSuccess:
    """200 response from `POST /v1/run`."""

    run_id: str
    output: Any
    trace: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RunSuccess:
        return cls(
            run_id=str(d["run_id"]),
            output=d.get("output"),
            trace=d.get("trace"),
        )


# ── response: failure ────────────────────────────────────────────────


@dataclass(frozen=True)
class ErrorEnvelope:
    """The `error: {...}` object inside a failure response."""

    kind: str
    message: str
    details: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> ErrorEnvelope:
        return cls(
            kind=str(d["kind"]),
            message=str(d.get("message", "")),
            details=d.get("details"),
        )


@dataclass(frozen=True)
class RunFailure:
    """Non-200 response from `POST /v1/run`.

    `run_id` is null on pre-dispatch errors (input_invalid, unknown_gen,
    unknown_method, tool_dispatch_failed, timeout, overloaded, booting,
    not_found) and string-valued when the runner produced one
    (validation_failed, budget_exhausted, runner_error from
    runGen-internal failures).
    """

    run_id: str | None
    error: ErrorEnvelope
    trace: dict[str, Any] | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> RunFailure:
        raw_id = d.get("run_id")
        return cls(
            run_id=None if raw_id is None else str(raw_id),
            error=ErrorEnvelope.from_dict(d["error"]),
            trace=d.get("trace"),
        )


# ── healthz ──────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Healthz:
    """Response from `GET /v1/healthz`."""

    status: str
    gens: list[str] = field(default_factory=list)
    version: str = WIRE_VERSION

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Healthz:
        return cls(
            status=str(d.get("status", "")),
            gens=list(d.get("gens", [])),
            version=str(d.get("version", WIRE_VERSION)),
        )
