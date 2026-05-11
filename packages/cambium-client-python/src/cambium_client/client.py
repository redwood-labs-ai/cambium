"""Sync `CambiumClient`.

Talks the v1 wire format over HTTP via `httpx`. Async parity lands in
slice 5 (same class, shared dispatch helper); UDS coverage already
works via slice 3's `transport.parse_url` and is exercised
end-to-end in slice 7.

Migration target shape (matches redwood-ats's `services/cambium.py`):

    with CambiumClient(url="http://cambium-runner:9000") as client:
        output = client.run("ResumeParser", "analyze", resume_text)

`run()` returns the bare `output` dict on success — callers who want
the `run_id` for correlation pass `include_trace=True` and read it
from the trace, or open a follow-up ticket for a `run_envelope()`
companion method.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

import httpx

from .errors import (
    CambiumConnectionError,
    CambiumError,
    RunnerError,
    exc_for_kind,
)
from .transport import parse_url
from .wire import Healthz, RunFailure, RunRequest


# httpx exceptions that mean "we couldn't reach the server at all" —
# distinct from a server response with a structured `error.kind`. All
# get rewrapped as `CambiumConnectionError` so callers have ONE thing to
# catch for transport failures.
_CONNECT_ERRORS: tuple[type[Exception], ...] = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.NetworkError,
)


class CambiumClient:
    """Client for a running `cambium serve` instance.

    URL forms (parsed by `transport.parse_url`):
        http://host:port      / https://host:port
        tcp://host:port       (rewritten to http://; matches `cambium serve --bind`)
        unix:///abs/path      (Mac/Linux UDS via httpx transport)
        pipe://name           (deferred to v1.1; raises NotImplementedError)

    Args:
        url: Cambium server URL. Required.
        timeout: Per-request timeout in seconds. Default 30.
        headers: Extra HTTP headers (e.g. tracing). Optional.
        probe: If True, call `/v1/healthz` from the constructor and
            raise `CambiumConnectionError` if the server isn't reachable
            (or `BootingError` if it's still loading gens). Default False.
    """

    def __init__(
        self,
        url: str,
        *,
        timeout: float = 30.0,
        headers: Mapping[str, str] | None = None,
        probe: bool = False,
        _transport_sync: httpx.BaseTransport | None = None,
        _transport_async: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        cfg = parse_url(url)
        self._url = url
        self._timeout = timeout
        # `_transport_*` underscore-prefixed: test-only override. Production
        # callers pass `url`; httpx.MockTransport injection is for unit tests.
        sync_t = _transport_sync if _transport_sync is not None else cfg.transport_sync
        async_t = _transport_async if _transport_async is not None else cfg.transport_async
        self._sync: httpx.Client = httpx.Client(
            base_url=cfg.base_url,
            transport=sync_t,
            timeout=timeout,
            headers=dict(headers) if headers else None,
        )
        self._async: httpx.AsyncClient = httpx.AsyncClient(
            base_url=cfg.base_url,
            transport=async_t,
            timeout=timeout,
            headers=dict(headers) if headers else None,
        )
        if probe:
            # healthz raises CambiumConnectionError on connect failure and
            # BootingError on 503 booting — both are useful signals to a
            # caller that wanted construction-time validation.
            self.healthz()

    def __repr__(self) -> str:
        return f"CambiumClient(url={self._url!r}, timeout={self._timeout})"

    # ── context manager ─────────────────────────────────────────────

    def __enter__(self) -> "CambiumClient":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def close(self) -> None:
        """Close the sync httpx Client pool.

        Idempotent. If you used both sync and async paths from the same
        instance, also call `aclose()` from an async context (or use
        the async context manager).
        """
        self._sync.close()

    async def __aenter__(self) -> "CambiumClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the async httpx Client pool. Idempotent.

        Closes both sync + async pools so an `async with` block cleans
        up everything (matches what most callers expect from a single
        context-managed lifetime).
        """
        await self._async.aclose()
        self._sync.close()

    # ── public methods ──────────────────────────────────────────────

    def run(
        self,
        gen: str,
        method: str,
        input: Any,
        *,
        memory_keys: Mapping[str, str] | None = None,
        fired_by: str | None = None,
        include_trace: bool = False,
    ) -> Any:
        """Dispatch a gen run and return the validated output.

        Returns:
            The `output` field from the server's response (whatever the
            gen produced, validated against its schema). Type depends on
            the gen's `returns` schema — usually a dict.

        Raises:
            CambiumConnectionError: server unreachable.
            UnknownGenError, UnknownMethodError, InputInvalidError:
                pre-dispatch errors (HTTP 400 from server).
            ValidationFailedError, BudgetExhaustedError, RunnerError:
                runner-internal failures (HTTP 500 from server, run_id
                surfaced on the exception).
            CambiumTimeoutError: deadline exceeded (HTTP 504).
            OverloadedError: server hit `--max-inflight` cap (HTTP 503).
            BootingError: server still pre-compiling (HTTP 503).
            ToolDispatchFailedError: gen declared a tool/action/security
                requirement the runtime can't honor (HTTP 400).
        """
        body = RunRequest(
            gen=gen,
            method=method,
            input=_normalize_input(input),
            memory_keys=dict(memory_keys) if memory_keys else None,
            fired_by=fired_by,
            include_trace=include_trace,
        ).to_dict()
        response = self._post_run_sync(body)
        return self._dispatch_run_response(response)

    def healthz(self) -> Healthz:
        """Probe `/v1/healthz`.

        Returns:
            The parsed `Healthz` payload (`status`, `gens`, `version`).

        Raises:
            CambiumConnectionError: server unreachable.
            BootingError: server still pre-compiling at boot (HTTP 503).
            CambiumError: any other non-200 response.
        """
        try:
            response = self._sync.get("/v1/healthz")
        except _CONNECT_ERRORS as e:
            raise CambiumConnectionError(
                f"could not reach Cambium server at {self._url}: {e}",
                kind="connection_error",
            ) from e
        return self._dispatch_healthz_response(response)

    async def run_async(
        self,
        gen: str,
        method: str,
        input: Any,
        *,
        memory_keys: Mapping[str, str] | None = None,
        fired_by: str | None = None,
        include_trace: bool = False,
    ) -> Any:
        """Async sibling of `run`. Same semantics, same exception tree.

        Shares the dispatch + failure-envelope helpers with the sync
        path — those operate on `httpx.Response`, which is the same
        type sync and async return.
        """
        body = RunRequest(
            gen=gen,
            method=method,
            input=_normalize_input(input),
            memory_keys=dict(memory_keys) if memory_keys else None,
            fired_by=fired_by,
            include_trace=include_trace,
        ).to_dict()
        try:
            response = await self._async.post("/v1/run", json=body)
        except _CONNECT_ERRORS as e:
            raise CambiumConnectionError(
                f"could not reach Cambium server at {self._url}: {e}",
                kind="connection_error",
            ) from e
        return self._dispatch_run_response(response)

    async def healthz_async(self) -> Healthz:
        """Async sibling of `healthz`. Same return / raise contract."""
        try:
            response = await self._async.get("/v1/healthz")
        except _CONNECT_ERRORS as e:
            raise CambiumConnectionError(
                f"could not reach Cambium server at {self._url}: {e}",
                kind="connection_error",
            ) from e
        return self._dispatch_healthz_response(response)

    def _dispatch_healthz_response(self, response: httpx.Response) -> Healthz:
        """Shared healthz response parsing (sync + async)."""
        if response.status_code == 200:
            return Healthz.from_dict(response.json())
        # Non-200: usually 503 booting. Route through the failure-
        # envelope parser so the right exception subclass surfaces.
        self._raise_from_failure_envelope(response, default_kind="runner_error")
        # Unreachable — _raise_from_failure_envelope always raises on
        # a non-success body. If somehow it didn't, surface the status.
        raise CambiumError(
            f"healthz returned HTTP {response.status_code}",
            kind="runner_error",
        )

    # ── internal helpers ────────────────────────────────────────────

    def _post_run_sync(self, body: dict[str, Any]) -> httpx.Response:
        """POST /v1/run, mapping transport failures to CambiumConnectionError."""
        try:
            return self._sync.post("/v1/run", json=body)
        except _CONNECT_ERRORS as e:
            raise CambiumConnectionError(
                f"could not reach Cambium server at {self._url}: {e}",
                kind="connection_error",
            ) from e

    def _dispatch_run_response(self, response: httpx.Response) -> Any:
        """Convert a `/v1/run` HTTP response into either the output or a raise.

        Shared between sync and async paths (slice 5 reuses this).
        """
        body: Any
        try:
            body = response.json()
        except (json.JSONDecodeError, ValueError) as e:
            # Server returned non-JSON — bug in serve.ts or a reverse
            # proxy in the way. Surface as RunnerError; status code may
            # still help diagnose.
            raise RunnerError(
                f"server returned non-JSON ({response.status_code}): "
                f"{response.text[:200]}",
                kind="runner_error",
            ) from e

        if not isinstance(body, dict):
            raise RunnerError(
                f"server response body was not a JSON object ({response.status_code})",
                kind="runner_error",
            )

        if body.get("ok") is True:
            # Success path: return just the output (matches the migration
            # target's existing call shape).
            return body.get("output")

        # Failure path.
        self._raise_from_failure_envelope(response, default_kind="runner_error")
        # Unreachable.
        raise RunnerError(
            f"server returned ok=false without an error envelope ({response.status_code})",
            kind="runner_error",
        )

    def _raise_from_failure_envelope(
        self,
        response: httpx.Response,
        *,
        default_kind: str,
    ) -> None:
        """Raise the correct exception subclass from a failure-envelope body.

        Assumes the response body is JSON and has `ok: false` (or at
        least an `error` object). Falls back to the named default kind
        if the envelope is malformed.
        """
        try:
            body = response.json()
        except (json.JSONDecodeError, ValueError):
            raise exc_for_kind(default_kind)(
                f"server returned non-JSON ({response.status_code}): "
                f"{response.text[:200]}",
                kind=default_kind,
            )

        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            failure = RunFailure.from_dict(body)
            exc_cls = exc_for_kind(failure.error.kind)
            raise exc_cls(
                failure.error.message or "(no message)",
                kind=failure.error.kind,
                run_id=failure.run_id,
                details=failure.error.details,
            )

        # Body doesn't look like a Cambium failure envelope — surface
        # as the default kind so callers can still branch on something
        # structured.
        raise exc_for_kind(default_kind)(
            f"server returned HTTP {response.status_code} "
            f"without a Cambium failure envelope: {response.text[:200]}",
            kind=default_kind,
        )


def _normalize_input(input_value: Any) -> Any:
    """Convert `client.run(input=...)` into a JSON-serialisable value.

    The server's `injectInput` (serve.ts) accepts string, dict, list,
    null, or anything else (which it JSON.stringifies). On the Python
    side we only need to handle `bytes` specially — JSON can't carry
    raw bytes, so decode to UTF-8. Everything else passes through.
    """
    if isinstance(input_value, (bytes, bytearray, memoryview)):
        # Per the ticket: "bytes for pre-serialised payloads". Decode
        # as UTF-8 so the wire format stays JSON-clean.
        return bytes(input_value).decode("utf-8")
    return input_value
