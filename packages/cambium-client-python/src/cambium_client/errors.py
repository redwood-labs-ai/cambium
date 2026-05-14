"""Exception tree for `cambium-client`.

Mirrors the closed v1 `error.kind` enum from
`packages/cambium-runner/src/serve/serve.ts` 1:1 — one subclass per
kind, plus a `CambiumError` umbrella plus a connection layer for
"server unreachable" cases (which never appear on the wire — they're
raised by `httpx` when the request can't be delivered).

Naming notes:

* `CambiumTimeoutError`, not `TimeoutError` — Python's builtin
  `TimeoutError` is widely caught; shadowing it would cause silent
  catches in caller code.
* `CambiumConnectionError` is the canonical name for "couldn't reach
  the server." `CambiumNotFoundError` is preserved as an alias for
  back-compat with the existing redwood-ats subprocess-wrapper pattern
  (where `CambiumNotFoundError` meant "couldn't locate the cambium CLI
  binary" — same intent, different transport). Migration target is "swap
  one import"; the alias lets that hold.
* `CambiumRunError` is preserved as an alias of `RunnerError` for the
  same subprocess-wrapper migration story.

Every exception carries `.kind`, `.run_id` (string or None — null on
pre-dispatch errors per the wire format), and `.details` (dict from the
server's `error.details`, or None).
"""

from __future__ import annotations

from typing import Any, ClassVar


class CambiumError(Exception):
    """Umbrella exception for everything `cambium-client` raises.

    Carries the structured fields the server includes in its failure
    envelope. The base class doesn't pin a `kind`; subclasses do.
    """

    kind: ClassVar[str] = "cambium_error"

    def __init__(
        self,
        message: str,
        *,
        kind: str | None = None,
        run_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        # Subclass `kind` is the default; an explicit `kind=` overrides
        # it (useful if the server invents a kind we don't know about
        # yet — we'd surface it via the base class with the real kind).
        self.kind: str = kind if kind is not None else self.__class__.kind
        self.run_id: str | None = run_id
        self.details: dict[str, Any] | None = details


# ── wire kinds (one subclass per `error.kind` value) ──────────────────


class UnknownGenError(CambiumError):
    kind: ClassVar[str] = "unknown_gen"


class UnknownMethodError(CambiumError):
    kind: ClassVar[str] = "unknown_method"


class InputInvalidError(CambiumError):
    kind: ClassVar[str] = "input_invalid"


class ValidationFailedError(CambiumError):
    kind: ClassVar[str] = "validation_failed"


class BudgetExhaustedError(CambiumError):
    kind: ClassVar[str] = "budget_exhausted"


class ToolDispatchFailedError(CambiumError):
    kind: ClassVar[str] = "tool_dispatch_failed"


class RunnerError(CambiumError):
    kind: ClassVar[str] = "runner_error"


class CambiumTimeoutError(CambiumError):
    """Server-side run did not complete within `--run-timeout`.

    Named with the `Cambium` prefix so it doesn't shadow Python's
    builtin `TimeoutError` (which is widely caught and would otherwise
    silently absorb this exception).
    """

    kind: ClassVar[str] = "timeout"


class OverloadedError(CambiumError):
    kind: ClassVar[str] = "overloaded"


class BootingError(CambiumError):
    kind: ClassVar[str] = "booting"


class NotFoundError(CambiumError):
    kind: ClassVar[str] = "not_found"


# ── connection layer (no wire kind — raised on transport failure) ────


class CambiumConnectionError(CambiumError):
    """Server unreachable: connect refused, DNS, connect-timeout.

    Distinct from `NotFoundError` (which is the 404-route response). A
    client that catches this should retry with backoff or surface a
    "did you start `cambium serve`?" hint to the user.
    """

    kind: ClassVar[str] = "connection_error"


# ── back-compat aliases ──────────────────────────────────────────────
#
# Plain assignments — the alias IS the same class, so `isinstance(...,
# CambiumNotFoundError)` and `except CambiumRunError` work transparently.
# Documented in module docstring + the redwood-ats migration path.

#: Back-compat alias for `CambiumConnectionError` (matches the existing
#: `services/cambium.py` naming in downstream services that wrapped
#: `cambium run` via subprocess).
CambiumNotFoundError = CambiumConnectionError

#: Back-compat alias for `RunnerError` (matches the subprocess-wrapper
#: pattern that named its catch-all `CambiumRunError`).
CambiumRunError = RunnerError


# ── kind → exception lookup table ────────────────────────────────────
#
# Used by `client._dispatch_response` to map an incoming `error.kind`
# value to the right subclass. Tests assert this table covers every
# kind emitted by `serve.ts`.

_KIND_TO_EXC: dict[str, type[CambiumError]] = {
    "unknown_gen": UnknownGenError,
    "unknown_method": UnknownMethodError,
    "input_invalid": InputInvalidError,
    "validation_failed": ValidationFailedError,
    "budget_exhausted": BudgetExhaustedError,
    "tool_dispatch_failed": ToolDispatchFailedError,
    "runner_error": RunnerError,
    "timeout": CambiumTimeoutError,
    "overloaded": OverloadedError,
    "booting": BootingError,
    "not_found": NotFoundError,
}


def exc_for_kind(kind: str) -> type[CambiumError]:
    """Map an `error.kind` string to its exception subclass.

    Falls back to `CambiumError` for an unknown kind — if the server
    adds a new kind in a future release, callers see a structured
    `CambiumError` with the real `.kind` populated rather than the
    request silently succeeding.
    """
    return _KIND_TO_EXC.get(kind, CambiumError)
