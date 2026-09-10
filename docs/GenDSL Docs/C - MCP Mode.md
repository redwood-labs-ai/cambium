# Runtime: MCP Mode

**Doc ID:** gen-dsl/runtime/mcp-mode

## Purpose

Expose a Cambium workspace's gens and pipelines as typed MCP tools over stdio, so any MCP-speaking agent host (Claude Desktop, Claude Code, an IDE's agent panel, a custom orchestrator) can call them with zero glue code — no hand-written tool JSON, no wrapper server, no re-derivation of what a gen accepts or returns. `cambium mcp` is an **adapter**, not a second runtime: it boots `cambium serve`'s HTTP core in-process on a private socket and relays `/v1/gens` + `/v1/run` traffic into MCP's `tools/list` / `tools/call` shape. Every invariant `cambium serve` enforces (RED-137 dispatch + SSRF guard, the closed `error.kind` enum, boot fail-fast) holds unchanged underneath.

#198. Consumes #197's `/v1/gens` catalog.

## Forcing case

An Omarchy agent config wants to call Cambium gens the same way it calls any other MCP tool — no bespoke HTTP client, no bespoke error handling, just `tools/call` like every other capability in its toolbox. Generalizes to any MCP host: a developer pointing Claude Desktop at their workspace's gens during iteration, a CI agent composing several Cambium gens as steps in a larger tool-using session.

## CLI

```bash
cambium mcp --workspace <path> [flags]

# Flags
--workspace <path>     Path to the workspace containing Genfile.toml. Defaults to ".".
--precompiled          Boot from each gen's sibling <gen>.ir.json artifact instead of
                       spawning `ruby compile.rb` — no Ruby needed on PATH. Same
                       semantics as `cambium serve --precompiled` (#195).
--ir-dir <dir>         Like --precompiled, but every artifact lives flat under
                       <dir>/<basename>.ir.json. Implies --precompiled; wins when
                       both are passed.
--mock                 Use the deterministic mock generator instead of a live LLM
                       on every tools/call dispatch.
```

There is no `--bind` flag — the transport is always stdio; the private socket underneath is an implementation detail (see "Architecture" below).

## Architecture: MCP-stdio ↔ `/v1`-HTTP adapter

`cambium mcp` boots `runServe` (the same function `cambium serve` calls) in-process, bound to a **private** socket rather than an operator-chosen `--bind` address:

- **POSIX:** a unix socket inside a fresh `fs.mkdtempSync(join(os.tmpdir(), 'cambium-mcp-'))` directory (mode `0700` by default) — reachable only by the same user, strictly narrower than `cambium serve`'s own default posture. Removed on shutdown.
- **Socket-path ceiling (POSIX).** The path is built under `TMPDIR`, and a unix socket path must fit `sockaddr_un.sun_path` — 104 bytes on macOS and the BSDs, 108 on Linux. A long `TMPDIR` pushes it over, so `makePrivateBind` measures the path *before* binding and refuses with the byte count, the platform limit, and a pointer at `TMPDIR`. Checking before the bind is deliberate: both of the things that happen otherwise are worse than a refusal. Node `>=23` fails the `listen` with a bare `EINVAL` naming no cause; Node `<23` silently **truncates** `sun_path`, so `listen` succeeds at an address that is not the one handed to the HTTP client, and every `tools/call` then fails to reach a server that is demonstrably running — and if the cut falls past the `0700` `mkdtemp` directory, the socket lands under a shared ancestor where any co-resident local user can connect to it, since a unix socket's access control is only the filesystem permissions on its path. Remedy: set `TMPDIR` to a shorter directory.
- **win32:** a named pipe, `pipe://cambium-mcp-<pid>-<random>`. Untested (CI is linux-only) — `node:http.request({ socketPath })` is documented to work against a named pipe the same way it does a unix socket, but this path has no automated coverage.

The MCP layer then speaks plain HTTP to that socket exactly the way any other `/v1` client would: `GET /v1/gens` once at boot to build the tool table, `POST /v1/run` per `tools/call`. This is the whole design: dispatch (cache lookup, input injection, error mapping) and boot (catalog load, compile/read, contracts preflight) are **reused byte-for-byte** from `runServe`, never reimplemented. A `structuredContent.error` on a failed `tools/call` is therefore a byte-equal relay of the `/v1/run` error envelope, by construction — not a second classification that could drift from the HTTP surface.

Loopback TCP was considered and rejected: an unauthenticated `/v1/run` on a loopback port is reachable by any local process for the lifetime of the `cambium mcp` process, which is strictly worse than a `0700` socket directory only the same user can reach.

```
packages/cambium-runner/src/
  mcp/
    mcp-stdio.ts       # protocol core: framing, lifecycle, tool-table derivation,
                       #   tools/call dispatch + error mapping. Exports runMcpStdio.
    mcp-stdio.test.ts

cli/
  mcp.mjs              # argv parsing, runMcpStdio, SIGTERM/SIGINT, --mock env wiring
  cambium.mjs          # cambium mcp case in the main dispatch switch
```

The runner package's public surface exports `runMcpStdio` alongside `runServe` — `opts` includes injectable `input`/`output` streams and the same `compileBare` / `runGenFromIrFn` / `runPipelineFromIrFn` overrides `runServe` accepts, so tests drive the whole protocol without Ruby or real stdio.

## Tool naming: `<GenName>__<method>`

Every (gen or pipeline, method) pair in the catalog becomes one MCP tool named `${GenName}__${method}` — double underscore, never a single `_` or a `.`/`:` separator. The adapter builds a `Map<toolName, {gen, method}>` at boot and **never parses a tool name back** into its parts; the table is the only source of truth.

This is a **stable public surface** — the moment an agent config names `MenuEntryGen__analyze`, that name is a contract. Reasons for the specific shape:

- `.` and `:` lose outright — several MCP hosts enforce `[A-Za-z0-9_-]` on tool names.
- A single `_` loses on legibility — gen names and method names both routinely contain underscores (`analyst_repair`, `generate_palette`), so `analyst_repair_generate_palette` is ambiguous about where the gen name ends.
- `__` is the established MCP tool-namespacing idiom.

The character set is guaranteed safe without extra validation: catalog names match `/^[A-Z][A-Za-z0-9_]*$/` (`gen-catalog.ts`'s `GEN_NAME_RE`) and Ruby method identifiers are `[A-Za-z0-9_]` — so every tool name matches `^[A-Za-z0-9_]+$`.

Two failure modes, both surfaced explicitly:

- **Collision.** If two catalog entries produce the same tool name (only possible via underscore-bearing names — e.g. a gen literally named to collide with another's `<Name>__<method>`), boot fails with a message naming both sources. Fail-loud, never silently de-duplicated or truncated.
- **Length.** A tool name over 64 characters gets a one-line stderr warning (some MCP hosts cap tool names at that length) but is still served — the adapter doesn't invent a truncation scheme, which would just move the ambiguity problem rather than solve it.

## Input schema: the `{ input: ... }` wrapper

`/v1/run`'s body is `{gen, method, input}`; `gen`/`method` are baked into the tool identity, so an MCP tool's arguments are always `{ "input": ... }` — a single wrapper key that mirrors the `/v1/run` wire vocabulary. This is the other stable, agent-visible contract `cambium mcp` commits to.

The shape of `input` is derived **per catalog entry** (not per method — an entry's methods share one derived schema; only the tool `description` varies per method, so sibling tools stay distinguishable):

| Catalog shape | `inputSchema` | Notes |
| -- | -- | -- |
| gen | `{ type: 'object', properties: { input: { type: 'string', description: "Content for the gen's <key> context" } }, required: ['input'] }` | `<key>` is harvested from the catalog's `example.input` placeholder (`"<document>"` → `document`). |
| pipeline, 1 slot | Same string shape, description naming the slot. | |
| pipeline, N≥2 slots | `input` is itself `{ type: 'object', properties: { <slot>: { type: 'string' }, … }, required: [all slots], additionalProperties: false }`. | Slot names are the keys of the catalog's `example.input` object. `additionalProperties: false` matches the exact-keys enforcement below (AUD-198-F1) — a client that pre-validates against this schema gets the same answer `tools/call` gives. |
| pipeline, 0 slots | `input` optional (`required: []`). | Omitted `input` forwards `""` — the same zero-slot default the catalog's own example shows. |

`description`: the catalog's `entry.description`, falling back to `Run <Gen>.<method>`; when the entry has more than one method, ` (method: <method>)` is appended so sibling tools remain distinguishable in a flat tool list.

`outputSchema` on the tool is the catalog's `returns[method]` when non-null (so `structuredContent` on a successful call conforms to it); the field is **omitted entirely**, never emitted as `null`, when the method has no return schema — every pipeline method, and any gen method whose schema couldn't be resolved.

A flat `{ input }` wrapper was chosen over flattening pipeline slots to top-level argument keys: a top-level `input` key mirrors the `/v1/run` body agents may already know, and flattening would collide with any future non-input argument and diverge from the `/v1/run` shape for no gain.

### Argument validation (`tools/call`, closes AUD-198-01)

`tools/call` validates `arguments` structurally against the SAME closed shape the tool's advertised `inputSchema` was derived from, **before** dispatch — the "malformed params → `-32602`" clause of DEC-008 made real:

| Catalog shape | Requirement | Violation |
| -- | -- | -- |
| gen / pipeline, 1 slot | `arguments.input` present and a string | `-32602`, message names `input` |
| pipeline, N≥2 slots | `arguments.input` an object whose keys are EXACTLY the declared slots, each a string | `-32602`, message names the missing/extra/mistyped field (e.g. `input.doc`) |
| pipeline, 0 slots | `input` optional; a string when present | `-32602` only if present and non-string |

A call that fails its own advertised schema never reaches `POST /v1/run` — a gen tool invoked with no `input` (or the wrong type) gets `-32602` naming the field, not a confident answer generated from an empty document. No AJV, no new dependency: the shape set (`InputShape`) is closed, so a hand-rolled structural check is exact.

## Result / error mapping

MCP gives a tool call two channels: a JSON-RPC-level error (protocol failure — the call couldn't be attempted as described) and a tool **result** with `isError: true` (the call was attempted and failed on its own terms — the calling model needs to see this to react). `cambium mcp` keeps the two firmly separated:

**Success** (`/v1/run` responded `ok: true`):

```json
{
  "content": [{ "type": "text", "text": "{\"summary\":\"...\"}" }],
  "structuredContent": { "summary": "..." }
}
```

**Dispatch failure** (`/v1/run` responded `ok: false`, any HTTP status) — the `/v1/run` error envelope relayed **verbatim**, structural in both channels, never prose-only:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "{\"error\":{\"kind\":\"validation_failed\",\"message\":\"...\"},\"run_id\":\"run_...\"}" }],
  "structuredContent": { "error": { "kind": "validation_failed", "message": "..." }, "run_id": "run_..." }
}
```

This covers every kind the run path can emit: `unknown_gen`, `unknown_method`, `input_invalid`, `validation_failed`, `budget_exhausted`, `tool_dispatch_failed`, `runner_error`, `timeout`, `output_ceiling`. `overloaded` is mapped too (the wire enum is closed and the adapter relays whatever `/v1/run` sends) but is unreachable in practice — the adapter sets no `maxInflight` on its internal `runServe` call. `booting` and `not_found` cannot surface at all: the adapter answers nothing before its own `ready` resolves (so `booting` is never observed), and it only ever calls the two fixed routes (so `not_found` never fires).

**Protocol failures** stay JSON-RPC errors, and invent no `error.kind`:

| Situation | JSON-RPC error |
| -- | -- |
| Unknown tool name in `tools/call` | `-32602` (Invalid params) — `tools/list` is authoritative |
| Malformed `tools/call` params | `-32602` |
| Unknown method | `-32601` (Method not found) |
| Parse error (invalid JSON on the line) | `-32700` |
| JSON-RPC batch (an array request) | `-32600` (Invalid Request) — MCP 2025-06-18 removed batching |

The adapter never retries, transforms, or re-classifies a dispatch failure — `structuredContent.error` is byte-equal to the `/v1/run` response's `error` field, by construction (see "Architecture").

## Framing and protocol lifecycle

**Framing:** newline-delimited JSON-RPC 2.0, one message per line — the MCP stdio transport's actual spec (Content-Length framing is LSP, not MCP). Lines are split by hand (not `node:readline`, so a single line's size can be capped — see below); written one `JSON.stringify`'d line at a time (which never emits a raw embedded newline). No batching — a JSON array is answered `-32600`.

**Stdin line cap + resync (DEC-012, closes security-pass Finding 2).** A single stdin line is capped at 16 MiB — comfortably above the 10 MB `/v1/run` body cap plus JSON-RPC framing overhead, so no legitimate frame is ever refused. A line over the cap gets a `-32700`-class error naming the limit (`id: null`) and the adapter enters discard-until-newline mode for the rest of that line; the very next newline resyncs the stream and normal framing resumes immediately after it. Bounded memory, no process kill — a single oversized document produces one error frame, not a dead server.

**Protocol hygiene.** A request whose `jsonrpc` field isn't exactly `'2.0'`, or whose `id` isn't a string, number, or `null`, is rejected with `-32600` (the invalid id, when present, is echoed as `null` rather than as itself, since it couldn't be validated). Requests answered **before** `initialize` are intentionally tolerated — a client that sends `tools/list` before completing the handshake still gets a normal answer. Neither of these is required by DEC-005; both are cheap, spec-aligned hygiene, not lifecycle enforcement — a strict host never triggers either path, and a lenient one still gets correct answers.

**Protocol revision negotiation** (`initialize`): the server knows `2025-06-18`, `2025-03-26`, and `2024-11-05`. It echoes the client's requested revision when it's one of those three; otherwise it answers its own latest (`2025-06-18`), per spec. Capabilities are `{ tools: {} }` — no `listChanged`, because the tool catalog is fixed at boot, the same as `cambium serve`'s own catalog. `serverInfo` is `{ name: 'cambium', version: <runner package.json version> }`.

Also handled: `notifications/initialized` (ignored — it's a notification), `ping` (responds `{}`), any other method (`-32601` if it carried an id, silently ignored if it didn't — MCP notifications draw no response). `tools/list` returns every tool in one page; a `cursor` param is ignored and no `nextCursor` is emitted.

**Lifecycle:** the input loop starts immediately, but every message — including `initialize` — is queued behind the adapter's own boot sequence (private-socket bind, `runServe` boot, the initial `GET /v1/gens` fetch). This is why `booting` never reaches an MCP client: nothing is answered until the server is actually ready, and MCP clients are expected to tolerate a slow `initialize`. Boot failure surfaces as a rejected `ready` on the library handle; `cli/mcp.mjs`'s catch turns that into a stderr message, calls `handle.close()` (idempotent, null-safe — it owns the private socket directory's removal, so a boot failure never leaks it; closes AUD-198-02), and then `process.exit(1)` — the standard "server failed to start" signal an MCP host reads from the dead process. stdin EOF (the client disconnected) triggers a clean shutdown — closing the underlying `runServe` handle and removing the socket directory — after which `cli/mcp.mjs` exits `0`. SIGINT/SIGTERM trigger the same shutdown path.

`cambium mcp`'s **stdout is protocol-only** — every byte on it must be a JSON-RPC frame. Two layers of belt-and-braces, both in `cli/mcp.mjs` (never in the runner-package protocol core, so unit tests injecting their own `input`/`output` streams are never affected — the rebind only fires when this CLI is driving real process stdio):

1. `console.log = console.error` at startup, so a stray library or tool-plugin `console.log` can never corrupt the stream.
2. **DEC-009a (closes AUD-198-03).** The real `process.stdout.write` is captured FIRST (`rawStdoutWrite`) and handed to `runMcpStdio` as its `output` — the adapter's frame writer uses this captured reference directly, bypassing whatever `process.stdout.write` is later reassigned to. `process.stdout.write` itself is then rebound to forward to stderr, so an in-process plugin (a tool, corrector, log-sink, or custom provider — anything running inside the same process during a `tools/call`) that writes directly via `process.stdout.write(...)` can no longer corrupt the protocol stream either.

**Residual risk, named rather than silently accepted:** nothing lower-level than `process.stdout.write` is intercepted — a plugin that reaches for the raw file descriptor (`fs.writeSync(1, ...)`) or a native addon that writes to fd 1 directly bypasses both layers. No such writer exists anywhere in this repo today (verified by the security audit — SECURITY-AUDIT-198-2026-09-08.md § AUD-198-03); this is a theoretical residual for third-party plugin authors, not a known gap. Plugin authors: never write to stdout (or fd 1) directly during a run — `cambium mcp` owns it.

## Zero new dependencies

JSON-RPC framing is hand-rolled on `node:http` / `process.stdin`/`stdout` (a hand-rolled line splitter, not `node:readline`, so DEC-012's per-line cap can be enforced) — no MCP SDK, no new `package.json` entries anywhere. This is a hard constraint (see `CLAUDE.md` § Dependency policy), not an incidental choice: it happens to coincide with what the MCP stdio spec actually asks for (newline-delimited JSON, no framing library needed).

## Out of scope (v1)

- **HTTP/SSE MCP transports.** Stdio only; a host that wants HTTP should put a reverse proxy or its own adapter in front.
- **MCP `resources` / `prompts` / sampling.** Only `tools/list` + `tools/call` are implemented.
- **`listChanged` notifications.** The tool catalog is fixed at boot, mirroring `cambium serve`'s own boot-fixed catalog.
- **`--mock` on `cambium serve`'s CLI.** The underlying `RunServeOptions.mock` library option is real (and `cambium mcp --mock` uses it), but `cambium serve` itself gained no new flag — out of scope for this ticket.
- **Any `/v1` route or wire-format change.** `cambium mcp` is a pure consumer of the existing `/v1/gens` + `/v1/run` surface; it introduces no new `error.kind` value.
- **Auth.** Inherits `cambium serve`'s unauthenticated-in-v1 posture; the private per-process socket narrows exposure (see "Architecture") but does not add authentication.
- A CLI shim's `--catalog` flag or any Omarchy-side configuration consuming this — downstream tooling, not part of this surface's contract.

## See also

- [[C - Serve Mode]] — the HTTP core this adapts; the `/v1/gens` catalog shape, the closed `error.kind` enum, and the boot/lifecycle model this reuses unchanged.
- [[C - IR (Intermediate Representation)]] — what a gen/pipeline method's `returnSchema` (surfaced here as a tool's `outputSchema`) comes from.
- [[N - App Mode vs Engine Mode (RED-220)]] — the app-root anchoring `cambium mcp` inherits via `runServe`.
