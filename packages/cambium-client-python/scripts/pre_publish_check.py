#!/usr/bin/env python3
"""pre_publish_check — automated gate that MUST pass before `twine upload`.

Mirrors the philosophy of `scripts/pre-publish-check.mjs` for the npm
side: validate the published *artifact*, not the source tree, by:

  1. Building the wheel into a tmpdir.
  2. Creating a fresh venv.
  3. `pip install <wheel-path>` (NOT `-e .` — the source tree could hide
     a packaging bug that disappears only when the wheel is installed).
  4. Smoke-importing the public surface — if a refactor accidentally
     dropped an export, this catches it.
  5. Asserting `py.typed` ships inside the wheel (PEP 561 — mypy/pyright
     break for callers without it).
  6. Asserting `__version__` in the installed wheel matches what
     `pyproject.toml`'s dynamic-version source declares.
  7. Asserting the wheel contains no stray `tests/` or `__pycache__/`
     directories. Either would bloat the install and pollute callers'
     site-packages.

Exit codes:
  0  — safe to publish
  1+ — do NOT publish; fix the failure first

Usage:
    cd packages/cambium-client-python
    python scripts/pre_publish_check.py
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
import venv
import zipfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
PKG_ROOT = HERE.parent
VERSION_PY = PKG_ROOT / "src" / "cambium_client" / "_version.py"


_failures: list[str] = []


def _assert(cond: bool, msg: str) -> None:
    """Mirrors the npm script's ✓ / ✗ style for consistent output."""
    if cond:
        print(f"  ✓ {msg}")
    else:
        print(f"  ✗ {msg}")
        _failures.append(msg)


def _run(*cmd: str, cwd: Path | None = None) -> str:
    """Run a subprocess and return stdout. Surface stderr on failure."""
    result = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        sys.stderr.write(
            f"\n[pre_publish_check] command failed (exit {result.returncode}):\n"
            f"  {' '.join(cmd)}\n"
            f"  stdout: {result.stdout[-1000:]}\n"
            f"  stderr: {result.stderr[-1000:]}\n"
        )
        sys.exit(1)
    return result.stdout


def _expected_version() -> str:
    """Read `__version__` from `_version.py` without importing the package."""
    text = VERSION_PY.read_text(encoding="utf-8")
    match = re.search(r'__version__\s*=\s*"([^"]+)"', text)
    if not match:
        sys.stderr.write(f"could not parse __version__ from {VERSION_PY}\n")
        sys.exit(1)
    return match.group(1)


def main() -> int:
    print(f"[pre_publish_check] package: {PKG_ROOT}")
    expected_version = _expected_version()
    print(f"[pre_publish_check] expected version: {expected_version}")

    with tempfile.TemporaryDirectory(prefix="cambium-client-pre-publish-") as tmp:
        tmp_path = Path(tmp)
        wheel_dir = tmp_path / "dist"
        venv_dir = tmp_path / "venv"

        # ── 1. Build the wheel ────────────────────────────────────────
        print("\n[pre_publish_check] 1/6 building wheel…")
        _run(
            sys.executable, "-m", "build", "--wheel",
            "--outdir", str(wheel_dir),
            str(PKG_ROOT),
        )
        wheels = sorted(wheel_dir.glob("cambium_client-*.whl"))
        _assert(len(wheels) == 1, f"exactly one wheel built (got {len(wheels)})")
        if not wheels:
            return 1
        wheel = wheels[0]
        print(f"  → {wheel.name}")

        # ── 2. Inspect wheel contents BEFORE install (no execution) ────
        print("\n[pre_publish_check] 2/6 inspecting wheel contents…")
        with zipfile.ZipFile(wheel) as zf:
            names = zf.namelist()

        _assert(
            "cambium_client/py.typed" in names,
            "wheel ships PEP 561 `py.typed` marker",
        )
        _assert(
            "cambium_client/__init__.py" in names,
            "wheel ships `cambium_client/__init__.py`",
        )
        _assert(
            "cambium_client/client.py" in names,
            "wheel ships `cambium_client/client.py`",
        )
        _assert(
            not any(n.startswith("tests/") or "/tests/" in n for n in names),
            "wheel does NOT include `tests/` directory",
        )
        _assert(
            not any("__pycache__" in n for n in names),
            "wheel does NOT include `__pycache__/` directories",
        )
        _assert(
            not any(n.endswith(".pyc") for n in names),
            "wheel does NOT include `.pyc` files",
        )

        # Wheel filename version must match _version.py
        wheel_version_match = re.match(
            r"cambium_client-([0-9][^-]*)-", wheel.name
        )
        _assert(
            wheel_version_match is not None
            and wheel_version_match.group(1) == expected_version,
            f"wheel filename version matches `_version.py` ({expected_version})",
        )

        # ── 3. Create a fresh venv ────────────────────────────────────
        print("\n[pre_publish_check] 3/6 creating fresh venv…")
        venv.create(venv_dir, with_pip=True, clear=False)
        # Resolve the venv's python — different paths on Windows vs POSIX
        # but pre-publish is a maintainer-side tool so POSIX-only is OK.
        venv_python = venv_dir / "bin" / "python"
        if not venv_python.exists():  # Windows fallback if anyone runs it there
            venv_python = venv_dir / "Scripts" / "python.exe"
        _assert(venv_python.exists(), "venv python interpreter created")

        # ── 4. Install the wheel (NOT the source tree) ────────────────
        print("\n[pre_publish_check] 4/6 installing wheel into venv…")
        _run(
            str(venv_python), "-m", "pip", "install", "--quiet",
            str(wheel),
        )

        # ── 5. Smoke-import the public surface ────────────────────────
        print("\n[pre_publish_check] 5/6 smoke-importing public surface…")
        smoke = """
import cambium_client
from cambium_client import (
    CambiumClient,
    CambiumError,
    CambiumConnectionError,
    CambiumNotFoundError,
    CambiumRunError,
    CambiumTimeoutError,
    UnknownGenError,
    UnknownMethodError,
    InputInvalidError,
    ValidationFailedError,
    BudgetExhaustedError,
    ToolDispatchFailedError,
    RunnerError,
    OverloadedError,
    BootingError,
    NotFoundError,
    RunRequest,
    RunSuccess,
    RunFailure,
    ErrorEnvelope,
    Healthz,
    WIRE_VERSION,
    exc_for_kind,
)
import pathlib
mod_path = pathlib.Path(cambium_client.__file__).parent
print(f"__version__={cambium_client.__version__}")
print(f"WIRE_VERSION={WIRE_VERSION}")
print(f"py_typed_marker_exists={(mod_path / 'py.typed').is_file()}")
"""
        out = _run(str(venv_python), "-c", smoke)
        installed_version = None
        installed_wire_version = None
        py_typed_marker = None
        for line in out.splitlines():
            if line.startswith("__version__="):
                installed_version = line.partition("=")[2].strip()
            elif line.startswith("WIRE_VERSION="):
                installed_wire_version = line.partition("=")[2].strip()
            elif line.startswith("py_typed_marker_exists="):
                py_typed_marker = line.partition("=")[2].strip() == "True"

        _assert(
            installed_version == expected_version,
            f"installed __version__ matches `_version.py` ({expected_version})",
        )
        _assert(
            installed_wire_version == "v1",
            "installed WIRE_VERSION is 'v1'",
        )
        _assert(
            py_typed_marker is True,
            "installed package has `py.typed` marker on disk",
        )

        # ── 6. Confirm `twine check` is happy with the wheel ──────────
        print("\n[pre_publish_check] 6/6 twine check…")
        # twine isn't necessarily on PATH outside the dev venv; install
        # into the fresh venv for the check.
        _run(str(venv_python), "-m", "pip", "install", "--quiet", "twine")
        twine_out = _run(str(venv_python), "-m", "twine", "check", str(wheel))
        _assert("PASSED" in twine_out, "twine check passed")

    # ── Summary ───────────────────────────────────────────────────────
    print("\n[pre_publish_check] summary")
    if _failures:
        print(f"  ✗ {len(_failures)} check(s) failed:")
        for f in _failures:
            print(f"    - {f}")
        print("\nDO NOT PUBLISH. Fix the failures above and rerun.")
        return 1
    print("  ✓ all checks passed — safe to publish.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
