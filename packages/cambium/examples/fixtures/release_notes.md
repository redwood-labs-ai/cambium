# Cambium 0.9.4 — release notes

_Released 2026-08-28. See the [upgrade guide](https://example.invalid/docs/upgrade) before deploying._

## Highlights

- **Repair is 3x cheaper.** Structural repair now runs on the workspace
  `repair` model slot instead of the gen's model, cutting the median
  repair pass from 1,900 to 620 tokens.
- Grounded gens keep their provenance: a repair that *deletes* the
  citations it was asked to fix now fails the run instead of reporting
  success with nothing checked.
- `cambium inspect` opens a local, read-only trace viewer over `runs/`.

## Fixed

| Area | Symptom | Resolution |
|------|---------|------------|
| serve | catalog boot took 40s on large workspaces | one Ruby invocation per gen |
| memory | a changed embed model silently reused an old bucket | fails the run |
| budget | `per_tool` caps were checked after dispatch | checked before |

## Upgrading

Run `cambium compile --write` once after upgrading so generated
contracts match the new inline schema shape. Nothing else is required —
the IR is byte-identical for every gen that does not adopt a new
primitive.

> **Note:** workspaces pinning `cambium-runner` below 0.9.0 should
> upgrade both packages together. The runner and the CLI ship as a pair.

## Known issues

1. `--mock` cannot produce output for a novel inline schema (#205).
2. Firecracker network-enabled runs are cold-boot-only and not
   concurrency-safe.

Full changelog: [CHANGELOG.md](https://example.invalid/CHANGELOG.md)
