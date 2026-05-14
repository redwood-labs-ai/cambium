"""Single source of truth for the package version.

`pyproject.toml`'s `[tool.hatch.version]` reads this file. `__init__.py`
re-exports `__version__` so callers can `from cambium_client import __version__`.
"""

__version__ = "0.1.0"
