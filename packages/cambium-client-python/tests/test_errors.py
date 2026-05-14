"""Exception tree tests.

Pure-Python — no httpx, no real server. Verifies:

* Every subclass carries the right `.kind` and inherits from `CambiumError`.
* `exc_for_kind` dispatches correctly + falls back to base on unknown kind.
* `.run_id` and `.details` survive a round-trip.
* Back-compat aliases (`CambiumNotFoundError`, `CambiumRunError`) ARE the
  classes they alias — `isinstance` and `except` cover both names.
* `CambiumTimeoutError` does NOT shadow Python's builtin `TimeoutError`.
"""

from __future__ import annotations

import builtins

from cambium_client.errors import (
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


# ── Every subclass carries the right kind and inherits CambiumError ──


def test_every_subclass_inherits_cambium_error() -> None:
    for sub in (
        UnknownGenError, UnknownMethodError, InputInvalidError,
        ValidationFailedError, BudgetExhaustedError, ToolDispatchFailedError,
        RunnerError, CambiumTimeoutError, OverloadedError, BootingError,
        NotFoundError, CambiumConnectionError,
    ):
        assert issubclass(sub, CambiumError), f"{sub.__name__} must inherit CambiumError"


def test_class_kind_attribute_matches_wire_value() -> None:
    """The class-level `kind` attribute is the value the server emits."""
    assert UnknownGenError.kind == "unknown_gen"
    assert UnknownMethodError.kind == "unknown_method"
    assert InputInvalidError.kind == "input_invalid"
    assert ValidationFailedError.kind == "validation_failed"
    assert BudgetExhaustedError.kind == "budget_exhausted"
    assert ToolDispatchFailedError.kind == "tool_dispatch_failed"
    assert RunnerError.kind == "runner_error"
    assert CambiumTimeoutError.kind == "timeout"
    assert OverloadedError.kind == "overloaded"
    assert BootingError.kind == "booting"
    assert NotFoundError.kind == "not_found"


# ── exc_for_kind dispatch ────────────────────────────────────────────


def test_exc_for_kind_maps_each_kind() -> None:
    assert exc_for_kind("unknown_gen") is UnknownGenError
    assert exc_for_kind("validation_failed") is ValidationFailedError
    assert exc_for_kind("timeout") is CambiumTimeoutError
    assert exc_for_kind("overloaded") is OverloadedError


def test_exc_for_kind_falls_back_to_base_on_unknown_kind() -> None:
    """A future server kind we don't know about surfaces via the base class."""
    assert exc_for_kind("nope_brand_new_kind") is CambiumError


# ── Fields round-trip ────────────────────────────────────────────────


def test_constructor_carries_message_kind_run_id_details() -> None:
    e = UnknownGenError(
        "gen 'Ghost' is not in this server's catalog",
        run_id="run_xyz",
        details={"available": ["A", "B"]},
    )
    assert str(e) == "gen 'Ghost' is not in this server's catalog"
    assert e.kind == "unknown_gen"  # default from class
    assert e.run_id == "run_xyz"
    assert e.details == {"available": ["A", "B"]}


def test_run_id_defaults_to_none_for_pre_dispatch_errors() -> None:
    e = InputInvalidError("bad body")
    assert e.run_id is None
    assert e.details is None


def test_explicit_kind_overrides_class_default() -> None:
    """Useful when surfacing a future server kind via the base class."""
    e = CambiumError("future kind", kind="never_heard_of_it")
    assert e.kind == "never_heard_of_it"


# ── Back-compat aliases ──────────────────────────────────────────────


def test_cambium_not_found_error_is_cambium_connection_error() -> None:
    """The alias IS the class — `except CambiumNotFoundError` catches both names."""
    assert CambiumNotFoundError is CambiumConnectionError


def test_cambium_run_error_is_runner_error() -> None:
    assert CambiumRunError is RunnerError


def test_catch_via_alias_works() -> None:
    """`except CambiumRunError` should catch a `RunnerError` raise — identity."""
    caught = False
    try:
        raise RunnerError("boom")
    except CambiumRunError:
        caught = True
    assert caught


# ── Naming guard: don't shadow Python's builtin TimeoutError ─────────


def test_cambium_timeout_does_not_shadow_builtin() -> None:
    """A caller doing `except TimeoutError` should NOT accidentally catch ours."""
    assert CambiumTimeoutError is not builtins.TimeoutError
    assert not issubclass(CambiumTimeoutError, builtins.TimeoutError)
    # And we DO inherit Exception via CambiumError → so `except Exception`
    # still catches it (which is fine; that's the expected umbrella).
    assert issubclass(CambiumTimeoutError, Exception)
