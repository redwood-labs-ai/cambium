"""Slice 1 sanity test: the package is importable and exports a version string.

Subsequent slices replace this with real coverage, but committing one
trivially-passing test alongside the skeleton means the test runner is
already wired before any logic lands.
"""

import re

import cambium_client


def test_imports_cleanly() -> None:
    """`import cambium_client` returns a module."""
    assert cambium_client.__name__ == "cambium_client"


def test_version_string_is_semver_shaped() -> None:
    """Sanity-check the version string parses as MAJOR.MINOR.PATCH(-suffix)?"""
    assert re.match(r"^\d+\.\d+\.\d+(?:[-+].+)?$", cambium_client.__version__), (
        f"unexpected __version__: {cambium_client.__version__!r}"
    )


def test_all_only_exports_version() -> None:
    """Slice 1 ships only `__version__`; subsequent slices grow `__all__`."""
    assert cambium_client.__all__ == ["__version__"]
