# Getting Started

**Doc ID:** gen-dsl/getting-started

## Purpose
Get a minimal Cambium app running, producing a typed result with a trace.

## Assumptions
- Local-first model provider by default (e.g., Ollama).
- You have a TS runner that can execute compiled IR.

## Minimal app structure
See: [[01 - Core Concepts]] and the ref impl note.

## Hello world flow
1) Write a `GenModel` in `app/gens/` as `*.cmb.rb`.
2) Define a return schema/contract in `app/schemas/` (or TS TypeBox, if using that route).
3) Run: `cambium run app/gens/analyst.cmb.rb --method analyze --arg document.txt`
4) Inspect: `runs/<run_id>/trace.json`

## See also
- [[P - GenModel]]
- [[P - generate]]
- [[C - Trace (observability)]]
