"""Python client for Cambium serve mode.

Talks the v1 HTTP wire format documented in
`docs/GenDSL Docs/C - Serve Mode.md`. Provides a synchronous +
asynchronous `CambiumClient` plus an exception subclass per `error.kind`.

Public surface (this commit ships the typed-error layer; the runtime
`CambiumClient` lands in later slices):

    CambiumError             — umbrella for all client-raised exceptions.
    CambiumConnectionError   — server unreachable.
    CambiumNotFoundError     — back-compat alias of CambiumConnectionError.
    UnknownGenError, UnknownMethodError, InputInvalidError,
    ValidationFailedError, BudgetExhaustedError, ToolDispatchFailedError,
    RunnerError, CambiumTimeoutError, OverloadedError, BootingError,
    NotFoundError            — one per v1 error.kind.
    CambiumRunError          — back-compat alias of RunnerError.

    RunRequest, RunSuccess, RunFailure, ErrorEnvelope, Healthz,
    WIRE_VERSION             — wire-format dataclasses + version constant.
"""

from ._version import __version__
from .client import CambiumClient
from .errors import (
    BootingError,
    BudgetExhaustedError,
    CambiumConnectionError,
    CambiumError,
    CambiumNotFoundError,
    CambiumRunError,
    CambiumTimeoutError,
    InputInvalidError,
    NotFoundError,
    OverloadedError,
    RunnerError,
    ToolDispatchFailedError,
    UnknownGenError,
    UnknownMethodError,
    ValidationFailedError,
    exc_for_kind,
)
from .wire import (
    WIRE_VERSION,
    ErrorEnvelope,
    Healthz,
    RunFailure,
    RunRequest,
    RunSuccess,
)

__all__ = [
    # Version
    "__version__",
    # Client (slice 4 ships sync; slice 5 adds async parity)
    "CambiumClient",
    # Wire-format constants + dataclasses
    "WIRE_VERSION",
    "RunRequest",
    "RunSuccess",
    "RunFailure",
    "ErrorEnvelope",
    "Healthz",
    # Exception umbrella + dispatch helper
    "CambiumError",
    "exc_for_kind",
    # Connection layer
    "CambiumConnectionError",
    "CambiumNotFoundError",
    # Per-error.kind subclasses
    "UnknownGenError",
    "UnknownMethodError",
    "InputInvalidError",
    "ValidationFailedError",
    "BudgetExhaustedError",
    "ToolDispatchFailedError",
    "RunnerError",
    "CambiumTimeoutError",
    "OverloadedError",
    "BootingError",
    "NotFoundError",
    # Back-compat aliases
    "CambiumRunError",
]
