"""Python client for Cambium serve mode.

Talks the v1 HTTP wire format documented in
`docs/GenDSL Docs/C - Serve Mode.md`. Provides a synchronous +
asynchronous `CambiumClient` plus an exception subclass per `error.kind`.

Public surface:
    CambiumClient            — sync + async client; context-manager protocol.
    CambiumError             — umbrella for all client-raised exceptions.
    CambiumConnectionError   — server unreachable (connect refused, DNS, etc.).
    CambiumNotFoundError     — back-compat alias of CambiumConnectionError
                                (matches the existing subprocess-wrapper pattern
                                used by downstream services).
    UnknownGenError, UnknownMethodError, InputInvalidError,
    ValidationFailedError, BudgetExhaustedError, ToolDispatchFailedError,
    RunnerError, CambiumTimeoutError, OverloadedError, BootingError,
    NotFoundError            — one per v1 error.kind.
    CambiumRunError          — back-compat alias of RunnerError.

Following slices add the runtime surface; this commit ships only the
package skeleton so `python -m build` succeeds and `import cambium_client`
returns a versioned module.
"""

from ._version import __version__

__all__ = [
    "__version__",
]
