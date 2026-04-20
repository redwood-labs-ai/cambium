# Cambium — Rails for Generation Engineering

You are helping a developer work with **Cambium**, a DSL and runtime for building reliable LLM programs. Cambium compiles Ruby DSL (`.cmb.rb`) to JSON IR, executed by a TypeScript/Node runner with typed contracts, validation, repair loops, and full tracing.

## If the developer is new to Cambium

Walk them through creating their first agent. Use the CLI generators — don't write files manually.

### Step 1: Scaffold an agent
Ask what they want to build, then:
```bash
cambium new agent <AgentName>
```
This creates the `.cmb.rb` file, system prompt, and test.

### Step 2: Define the schema
```bash
cambium new schema <SchemaName>
```
This prints TypeBox boilerplate to add to `packages/cambium/src/contracts.ts`. Help them define the fields their agent should return.

### Step 3: Edit the system prompt
Open `packages/cambium/app/systems/<agent_name>.system.md` and help them write a focused role description.

### Step 4: Create a fixture
Help them create a test document in `packages/cambium/examples/fixtures/`.

### Step 5: Run it
```bash
CAMBIUM_OMLX_API_KEY=<key> cambium run packages/cambium/app/gens/<agent_name>.cmb.rb --method analyze --arg packages/cambium/examples/fixtures/<fixture>
```

### Step 6: Iterate
Look at the trace (`runs/<run_id>/trace.json`) and help them tune the agent — add constraints, correctors, signals, grounding.

## Key concepts

- **GenModel**: a Ruby class that declares an LLM program with contracts
- **`returns`**: typed output schema (TypeBox → JSON Schema → AJV validation)
- **`uses`**: tool access (deny-by-default, logged, typed)
- **`corrects`**: deterministic post-validation transforms (built-ins: math, dates, currency, citations). App-level `app/correctors/<name>.corrector.ts` files are auto-discovered in app-mode and override built-ins by name (RED-275). Correctors returning `corrected: false` with `severity: 'error'` issues trigger one additional repair attempt so the LLM can fix the flagged problem.
- **`constrain`**: runtime behavior changes (tone, compound review, consistency, budget)
- **`extract` + `on`**: signals extracted from output trigger deterministic actions
- **`enrich`**: sub-agent digests raw context before main generation
- **`grounded_in`**: citation enforcement with verbatim quote verification
- **`mode :agentic`**: multi-turn tool-use loop (model calls tools during generation)
- **`system`**: `:symbol` resolves to `app/systems/<name>.system.md`, string is inline
- **`security`** / **`budget`**: tool-execution policy + per-tool/per-run call caps. Inline form (`security network: { allowlist: [...] }`) or pull a bundled pack by symbol (`security :research_defaults` → `app/policies/<name>.policy.rb`). Per-slot mixing rule: each slot is set by exactly one source. See [`docs/GenDSL Docs/S - Tool Sandboxing (RED-137).md`](docs/GenDSL%20Docs/S%20-%20Tool%20Sandboxing%20%28RED-137%29.md) and [`P - Policy Packs (RED-214)`](docs/GenDSL%20Docs/P%20-%20Policy%20Packs%20%28RED-214%29.md).
- **Plugin tools**: adding a new tool is a paired set of files in `app/tools/` — `<name>.tool.json` (schema + permissions) and `<name>.tool.ts` (handler exporting `execute(input, ctx?)`). The registry auto-discovers both; no edits to `packages/cambium-runner/src/tools/index.ts` needed (RED-209). A plugin tool with the same name as a framework builtin wins — that's the override hook.
- **`memory`** *(RED-215 phases 2–5 — declare, execute, retro agents, semantic)*: declare per-gen memory slots (`memory :conversation, strategy: :sliding_window, size: 20` / `memory :facts, strategy: :semantic, top_k: 5, embed: "omlx:bge-small-en"` / `memory :activity, strategy: :log`). Scopes are `:session`, `:global`, or a named pool defined under `app/memory_pools/<name>.pool.rb`. The pool is authoritative on strategy/embed/keyed_by; the gen can only add reader knobs (`size`, `top_k`). At run time the runner opens one SQLite file per bucket (`runs/memory/<scope>/<key>/<name>.sqlite`), reads from it per strategy (`:sliding_window` → last N; `:semantic` → vec-search against `ctx.input`; `:log` → no read), injects the hits as a `## Memory` block in the system prompt, and — after a successful run — either appends one `{input, output}` entry (trivial default) or invokes the retro agent named by `write_memory_via :SomeAgent`. Retro agents have `mode :retro` + `reads_trace_of :primary` + `returns MemoryWrites`; their entry method is always `remember(ctx)` (Rails `ActiveJob#perform` analogue). Agent-written entries tag `written_by: 'agent:<ClassName>'`; failures never propagate to the primary (best-effort writes). Session id comes from `CAMBIUM_SESSION_ID` or is auto-generated and echoed to stderr. `--memory-key name=value` supplies values for `keyed_by` slots. Memory subsystem deps (`better-sqlite3`, `sqlite-vec`) are `optionalDependencies` — installs without memory use never pay for the native build. See [`P - Memory`](docs/GenDSL%20Docs/P%20-%20Memory.md).

## CLI commands

```bash
cambium run <file.cmb.rb> --method <method> --arg <path>   # compile + execute
cambium compile <file.cmb.rb> --method <method> [-o <ir.json>] # emit IR JSON without executing (engine-mode build step, RED-244)
cambium new engine|agent|tool|action|schema|system|corrector|policy|memory_pool <Name>   # scaffold (deterministic)
cambium new config models|memory_policy                        # scaffold app/config/<form>.rb (RED-237 / RED-239)
cambium new engine <Name>                                    # new engine folder under ./cambium/ (RED-246)
cambium new tool --describe "<description>"                 # agentic tool scaffolder (RED-216)
cambium test                                                 # run test suite
```

## Project structure

```
packages/cambium/
  app/
    gens/           # GenModel DSL files (.cmb.rb)
    systems/        # System prompts (.system.md)
    tools/          # App plugin tools — paired .tool.json + .tool.ts (auto-discovered)
    actions/        # App trigger actions — paired .action.json + .action.ts (RED-212)
    correctors/     # App corrector plugins (.corrector.ts) — auto-discovered, override built-ins (RED-275)
    policies/       # Policy packs (.policy.rb) — bundled security + budget
    memory_pools/   # Named memory pools (.pool.rb) — shared strategy+embed+keyed_by (RED-215)
    config/         # Workspace config — models.rb (RED-237), memory_policy.rb (RED-239)
  src/
    contracts.ts    # TypeBox schemas (single source of truth)
  tests/            # Vitest tests
  examples/
    fixtures/       # Test documents
packages/cambium-runner/   # @cambium/runner — TS runtime (RED-242)
  src/
    runner.ts         # TS runtime (executes IR)
    step-handlers.ts  # Generate, validate, repair, correct handlers
    builtin-tools/    # Framework-provided tools (RED-221): calculator, read_file,
                      # web_search, web_extract, execute_code — same plugin layout
                      # (.tool.json + .tool.ts) as app tools. App tools override
                      # framework builtins with the same name.
    tools/            # Tool framework infrastructure (registry, ToolContext,
                      # network-guard, permissions — NOT handlers)
    correctors/       # Built-in correctors (math, dates, currency, citations)
    signals.ts        # Signal extraction engine
    triggers.ts       # Trigger evaluation engine
    compound.ts       # Review + consensus engines
    enrich.ts         # Sub-agent enrichment
    schema-describe.ts # Auto-generated schema descriptions
ruby/cambium/
  runtime.rb        # GenModel DSL primitives
  compile.rb        # Ruby → JSON IR compiler
runs/               # Execution artifacts (ir.json, trace.json, output.json)
docs/GenDSL Docs/   # Full knowledge graph
```

## Documentation

Full docs are in `docs/GenDSL Docs/` — a knowledge graph with stable Doc IDs. Start with:
- `docs/GenDSL Docs/00 - Getting Started.md`
- `docs/GenDSL Docs/01 - Core Concepts.md`
- `docs/GenDSL Docs/Generation Engineering DSL — Docs Map (Knowledge Graph).md` (index of all docs)

Prefix key: **P** = Primitive, **C** = Compilation/Runtime, **D** = Data, **S** = Security, **N** = Design Note.

The spec drafts are in `docs/` (root level):
- `docs/Generation Engineering DSL (Rails-style) - Spec Draft.md`
- `docs/Generation Engineering DSL — Reference Implementation (v0).md`

Read these docs before making architectural decisions or adding new primitives.

## Development

- Tests: `npm test` (vitest)
- Providers supported for agentic mode:
  - **oMLX** (OpenAI-compatible): `CAMBIUM_OMLX_BASEURL` (default `http://100.114.183.54:8080`), optional `CAMBIUM_OMLX_API_KEY`. Model id: `"omlx:<name>"`.
  - **Ollama**: `CAMBIUM_OLLAMA_BASEURL` (default `http://localhost:11434`), no API key. Model id: `"ollama:<name>"` or a bare `"<name>"` (Ollama is the default when no `provider:` prefix).
- Qwen 3.5 thinking mode (oMLX): suppressed via `/no_think` token + `chat_template_kwargs`
- VS Code: syntax highlighting + LSP (hover, go-to-definition, completions) for `.cmb.rb`

## For contributors

The section above orients new users. This section is for anyone modifying Cambium itself (including Claude).

### Specialist agents

Dedicated Claude Code sub-agents live in `.claude/agents/`. Invoke them (via the `Agent` tool with `subagent_type:`) for concentrated context on specific concerns:

- **`cambium-security`** — reviews changes that touch tool dispatch, egress, the `security`/`budget` policy surface, tool registration, or code-generation paths. Enforces the 27 invariants locked in by RED-137 (SSRF guard, IP pinning, dispatch-site gates, budget pre-call checks), RED-214 (per-slot mixing, pack-name regex), RED-209 (plugin permission honesty), and RED-222 (scaffolder path-traversal + overwrite protection). **Use proactively** when modifying `packages/cambium-runner/src/tools/**`, `packages/cambium-runner/src/step-handlers.ts`, `packages/cambium-runner/src/runner.ts`, `packages/cambium-runner/src/triggers.ts`, adding a `*.tool.json` / `*.tool.ts` / `*.action.json` / `*.action.ts` / `*.policy.rb`, or changing the Ruby DSL's `security`/`budget` shape.
- **`cambium-docs`** — reviews the same-PR alignment between code and docs. Catches stale wikilinks after a rename, new DSL methods in `runtime.rb` that aren't documented, new IR fields missing from `C - IR`, new trace step types missing from `C - Trace`, and README project-structure tree drifting behind disk layout. **Use proactively** when modifying `ruby/cambium/runtime.rb`, `ruby/cambium/compile.rb`, `packages/cambium-runner/src/runner.ts` / `packages/cambium-runner/src/step-handlers.ts` / `packages/cambium-runner/src/triggers.ts` (new trace types), adding/renaming files under `docs/GenDSL Docs/`, or touching `CLAUDE.md` / `README.md`. Calibrated to flag user-visible misalignments, NOT prose or style nits.

### Non-obvious invariants

Things that will bite you if you don't know them:

- **Egress is enforced at fetch time, not at startup.** The static check in `validateToolPermissions` is an early warning. The real gate is `checkAndResolve` + `guardedFetch`. Tools that call `globalThis.fetch` bypass the entire guard — they must go through `ctx.fetch`. See `docs/GenDSL Docs/S - Tool Sandboxing (RED-137).md`.
- **Budget check happens before dispatch.** `handleToolCall` calls `budget.checkBeforeCall(toolName)` before invoking the tool. Reordering this lets a tool run once past its cap.
- **Budget violations terminate agentic loops.** When `checkBeforeCall` throws mid-loop, `budgetExhausted` flips true and the next turn forces final output. Without this the model retries the refused call indefinitely.
- **The old flat `security allow_network: true` / `allow_filesystem: true` / `allow_exec: true` / `network_hosts_allowlist: [...]` shapes are removed.** The Ruby DSL raises `ArgumentError` on them. Don't reintroduce these anywhere.
- **`parseBudget` accepts both the new `policies.budget` shape and the legacy `policies.constraints.budget`.** Needed for back-compat with `gaia_solver`.
- **`security exec: { allowed: true }` silently resolves to `runtime: 'native'` (RED-248 back-compat).** The `:native` substrate is unsandboxed; every dispatch emits a `tool.exec.unsandboxed` trace step + a one-per-run stderr warning. If you see `tool.exec.unsandboxed` in a trace, a gen is running `execute_code` without a sandbox. The rewrite is in `Normalize.normalize_exec` in `ruby/cambium/runtime.rb`. Don't remove the back-compat — it keeps existing in-tree gens compiling — but understand the tradeoff.
- **`CAMBIUM_STRICT_EXEC=1` promotes `:native` to a hard compile error (RED-249).** Opt-in env var. A shop that wants to block the fig-leaf path across the board sets this in CI; legacy `{ allowed: true }` gens fail at compile with `blocked by CAMBIUM_STRICT_EXEC=1`. Off by default — turning it on today breaks in-tree gens that still use the legacy shape.
- **`execute_code` refuses to dispatch without a `security exec:` block (RED-248).** Calling the tool with no `execPolicy` on ctx (either `{ allowed: true }` or the new `{ runtime:, ... }` shape) throws a hard error rather than silently running native. This is deny-by-default — a gen that declares `uses :execute_code` with no `security exec:` block will fail at runtime with a clear pointer to the fix.
- **WASM substrate uses `quickjs-emscripten`, not Wasmtime (RED-254).** The design note originally said "Wasmtime + QuickJS-WASM" but the shipped stack is QuickJS compiled to WebAssembly, hosted on Node's built-in `WebAssembly` support via the `quickjs-emscripten` npm package. Memory + wall-clock are enforced; CPU is accepted in the DSL but NOT enforced by `:wasm` (only `:firecracker`). No WASI preopens in v1 — filesystem capability is v1.5+. The `available()` probe uses `createRequire(import.meta.url)` because the package is ESM and a bare `require.resolve` would throw ReferenceError.
- **Firecracker snapshot cache keys on `(rootfs, kernel, canonical machine-config, allowlist signature)` content hashes (RED-256, extended RED-258).** The cache doesn't key on the Firecracker binary version — stale entries from a previous Firecracker release could silently load against a new binary with incompatible snapshot format. Operator-side migration after any Firecracker upgrade: `rm -rf $CAMBIUM_FC_SNAPSHOT_DIR/` (or the default `packages/cambium-runner/var/snapshots/`). The default cache root lives under `packages/cambium-runner/var/` so a workspace wipe takes it out along with other runtime scratch. The SHA-256 + 16-hex cache key is collision-resistant for workspace-local use but not bumped on FC version change. The allowlist signature (`hashAllowlist` in `firecracker-allowlist.ts`) covers each declared host directory's (relpath, size, mtime, inode) content signature — editing files under an allowlisted directory invalidates the cache entry automatically; you only need to wipe the cache dir manually on FC binary upgrades.
- **Firecracker filesystem allowlist is virtio-blk ext4, not bind-mount (RED-258).** `filesystem: { allowlist_paths: ['/data/in'] }` builds one read-only ext4 image per entry via `mke2fs -d`, caches it alongside the snapshot, attaches it as virtio-blk (`/dev/vdb`..`/dev/vdy`), and the in-guest agent mounts `-t ext4 -o ro`. Consequences: the `mke2fs` binary is a runtime dependency on the host (alongside `firecracker`); guests see the host directory as of image-build time, NOT live (editing a file while the VM runs does nothing until cache invalidation + rebuild); the hard cap is 24 allowlist entries (vda is rootfs; vdb..vdy = 24 slots); allowlist paths must be absolute, normalized, and not symlinks (`lstatSync` check — blocks `/opt/foo -> /etc` bypasses). Both the host (`normalizeAllowlistPaths` hardcodes `read_only: true`) AND the agent (`apply_mounts` in `crates/cambium-agent/src/mounts.rs` rejects `read_only: false`) enforce read-only — future rw support requires touching both enforcement points.
- **Allowlist path rejection is split: `DEEP_FORBIDDEN` (system-owned) vs `EXACT_FORBIDDEN` (user-land) (RED-258).** `firecracker-allowlist.ts` rejects prefix-and-all-subpaths for system-owned trees (`/bin`, `/boot`, `/dev`, `/etc`, `/init`, `/lib`, `/lib64`, `/proc`, `/root`, `/run`, `/sbin`, `/sys`, `/tmp`, `/usr`) but only the exact prefix for user-land POSIX directories (`/`, `/home`, `/mnt`, `/srv`, `/var`). Subpaths under user-land prefixes (e.g. `/home/user/project/data`, `/var/app/input`) are accepted — the guest-rootfs's `/home` and `/var` are essentially empty by Alpine default, so creating a mount point there doesn't shadow any real files. This is Cambium's opinionated Rails-style stance: the substrate takes a side on user-vs-system space rather than refusing the whole FHS top-level. If a gen author's data lives under `/etc/myapp/config`, they're in the wrong namespace — copy to `/opt/...` or `/home/...`. Don't widen `DEEP_FORBIDDEN` or narrow `EXACT_FORBIDDEN` without thinking about what guest-rootfs content would be shadowed.
- **Firecracker `non_canonical_sizing` is fail-open, not fail-closed (RED-256).** A gen requesting any `cpu` / `memory` that normalizes to something other than `(vcpu=1, mem=512 MiB)` silently bypasses the snapshot path and cold-boots, recording `ExecSnapshotFallback.reason = non_canonical_sizing` in the trace. This is intentional — cold-boot is always available — but it means performance expectations that assume warm-restore don't hold for non-standard sizing. The gap is invisible unless you're grepping `trace.json`. The canonical shape is locked in `firecracker-snapshot.ts` as `CANONICAL_VCPU` / `CANONICAL_MEM_MIB`; widening to a `(cpu, memory)` matrix is out of scope for v1.5.
- **Firecracker network allowlist is per-call netns + iptables (RED-259).** `network: NetworkPolicy` creates a fresh netns with a veth pair, a tap device, and iptables rules: DEFAULT DROP + ACCEPT for each resolved IP in the policy's allowlist + explicit DROPs for metadata / private ranges when the flags are set. Hostnames are pre-resolved on the host (the guest rootfs has no resolver); the agent writes the (name, ip) map to `/etc/hosts` from an `ExecRequest.net` field. Firecracker runs inside the netns via `sudo -n ip netns exec <name> firecracker …` so its virtio-net opens the tap fd from the right namespace. The same `sudo -n` prefix applies to the netns / iptables setup commands — `sudo -v` before dispatch, or `CAMBIUM_FC_NETNS_NOSUDO=1` for setcap setups, or `CAMBIUM_FC_PREPARED_NETNS=<name>` for operator-managed namespaces (pre-created out of band; Cambium skips setup/teardown and just uses it). IPv4 only in v1.
- **Network policy forces cold-only in v1 (RED-259).** When `network` is a NetworkPolicy, the substrate skips the snapshot path entirely and always cold-boots — combining net-allowlist with warm-restore needs a cache-key axis for net-enabled vs net-disabled that v1 doesn't ship. Gens with network policy pay ~200 ms per-call cold-boot overhead. The dispatch branch is in `execute()` right after `resolveScope`; don't silently re-enable snapshots for network-enabled gens without also extending the cache key.
- **Network-enabled `:firecracker` runs are not concurrency-safe in v1 (RED-259).** `firecracker-netns.ts` uses fixed device names (`cambium-fc` / `cam-fc-h` / `cam-fc-g` / `cam-fc-tap`) rather than per-call-unique identifiers. Two concurrent `:firecracker` runs with network policy race on setup — the second caller's `ip netns add` fails, or worse, the first caller's teardown wipes the second's state mid-run. Serialize at the caller (don't launch parallel gens that both use network) or pre-create per-caller netns names via `CAMBIUM_FC_PREPARED_NETNS`. Per-call unique names are a v1.5 follow-up — don't relax the invariant without adding a collision-detection guard.
- **`:firecracker` denylist is refused at dispatch, not silently ignored (RED-259).** `NetworkPolicy.denylist` is validated and carried through `resolveScope`, but `firecracker-dns.ts::resolveAllowlist` rejects any non-empty denylist at the scope boundary with a clear error. The rationale: RED-137's invariant says denylist wins over allowlist, and v1 doesn't yet implement per-denylist-entry DROP rules in the netns — silently dropping the denylist would let a gen under `:firecracker` have broader access than its `:native` equivalent, which is exactly the escalation direction we never want. v1.5 adds real denylist enforcement; until then, callers either remove the denylist or tighten the allowlist so the denylist is redundant.
- **Firecracker resource IDs are alphanumeric + underscores only (RED-258 + RED-259 R1 finding).** The FC API rejects hyphens in any `drive_id` / `iface_id` / `vsock_id` / similar with a 400 + `"API Resource IDs can only contain alphanumeric characters and underscores."`. The bug surfaced as `drive_id: "alw-0"` failing only in the escape-test matrix — the snapshot preflight had used `drive_id: "test"` and the unit tests didn't exercise the FC HTTP API at all. Future ID schemes (per-call-unique drive IDs in v1.5, additional vsock CIDs, etc.) MUST follow the underscore-only convention. The constraint is in the FC OpenAPI spec but not in FC's own error messages, so it's easy to miss when adding a new resource type.
- **Sockets FC creates in the netns path need `chmodSocketIfNetns` (RED-259).** When the substrate runs FC inside a netns via `sudo -n ip netns exec`, FC runs as root and creates UNIX sockets (the `/machine-config` API socket; the `/vsock` UDS) with the default 0755 mode — no write for non-owner. UNIX socket connect requires write access on the file, so the unprivileged Cambium runner gets EACCES on every connect attempt. `chmodSocketIfNetns(handle, path)` in `firecracker-netns.ts` is the fix: `sudo -n chmod 0666 <path>`. Called once per socket FC creates in `coldBootToAccept`. No-op when there's no netns or the runner is itself root. The per-call workdir is mode 0700 (mkdtemp default), so a 0666 socket inside it is only reachable by the workdir owner — broad perms on a per-call random-name socket are not a real-world exposure. Any new socket FC creates in the netns path needs the same chmod treatment.
- **`reUpTapAfterStart` MUST fire after `/actions InstanceStart` in any netns boot path (RED-259).** FC opens its tap fd at `PUT /network-interfaces` time, but the tap's OPER state can transiently drop to DOWN until traffic actually flows. The netns kernel marks the guest-subnet route as `linkdown` and `connect()` from the guest returns ENETUNREACH — even though the agent's `apply_net_config` brought up `eth0` and added the default route cleanly. Symptom is "everything looks configured, nothing connects, iptables is never even reached." The RED-259 preflight discovered this and the substrate's `coldBootToAccept` calls `reUpTapAfterStart(handle)` immediately after `/actions InstanceStart` (idempotent). Future refactors that reorder the dispatch sequence — or add a new netns-enabled boot path — MUST keep this re-up after InstanceStart.
- **Rebuild the rootfs after agent code changes (RED-259 R1 trap).** The guest agent is compiled from `crates/cambium-agent/` source into `firecracker-testbed/rootfs/out/rootfs.ext4` via the rootfs Dockerfile. Agent changes do NOT propagate to running VMs until the rootfs is rebuilt — the kernel boots whatever binary was baked in at last build time. The R1 escape-test debug burned multiple iterations on a stale rootfs whose agent didn't have the RED-259 `apply_net_config` logic. Symptom: `result.status === 'completed'` but the guest's `eth0` has no IP and `/etc/hosts` is empty (no `apply_net_config` call ever happened). Rebuild via `firecracker-testbed/rootfs/build.sh` (or the Dockerfile recipe) any time `crates/cambium-agent/` changes, then re-point `CAMBIUM_FC_ROOTFS` if needed.
- **Policy packs use per-slot mixing (RED-214).** `security` and `budget` accept either a Symbol pack name (`security :research_defaults`) or kwargs, but never both in one call. Across calls, each slot (`network` / `filesystem` / `exec` / `per_tool` / `per_run`) can be set by exactly one source — pack OR inline. The accumulator `_cambium_add_slots` is the enforcement point. The IR carries `_packs: [...]` listing contributing pack names; this is trace-only metadata — nothing on the TS side reads it for control flow.
- **Pack file names are restricted to `/\A[a-z][a-z0-9_]*\z/`.** A symbol like `:"../foo"` would otherwise interpolate into `File.join` and escape `app/policies/`. The check lives in `PolicyPack.load`. Don't relax it.
- **Memory pool file names share the same regex guard (RED-215).** `MemoryPool.load` uses the identical `/\A[a-z][a-z0-9_]*\z/` check before `File.join(dir, "#{name}.pool.rb")` for exactly the same path-traversal reason. Pool files are evaluated with `instance_eval` inside `MemoryPoolBuilder` — same model as `PolicyPackBuilder`. If you add new Ruby eval contexts loaded by symbol, copy both guards (regex + `CompileError` wrapping around `ScriptError/StandardError`).
- **`Genfile.toml [types].contracts` paths are validated at CLI startup, not silently skipped (RED-274).** `resolveGenfileContracts` in `packages/cambium-runner/src/genfile.ts` rejects absolute paths, null bytes, and any relative path whose `resolve()` escapes the Genfile directory (checked via `relative(genfileDir, abs).startsWith('..')`). Each resolved path is then `await import()`ed via `pathToFileURL`. This mirrors the RED-214 pack-name regex and RED-215 pool-name regex stance. If you add a new `Genfile.toml` section that loads user-declared file paths (e.g., `[tools].handlers` or `[policies].packs`), copy the same guards (null byte + `isAbsolute` + `relative(dir, abs).startsWith('..')`) — bare `path.join` normalises `..` silently and is not safe.
- **App correctors: basename regex + export name must match + realpath escape guard (RED-275).** `loadAppCorrectors` in `packages/cambium-runner/src/correctors/app-loader.ts` scans `<genfileDir>/app/correctors/*.corrector.ts`, requires each basename match `/^[a-z][a-z0-9_]*$/` (same stance as RED-214/215), `realpath`s the file and rejects any target that escapes the correctors dir (`relative(realDir, realFile).startsWith('..')`), and requires the module to export a function binding matching the basename. A throwing corrector is caught in `runCorrectorPipeline` and converted to a `severity: 'error'` issue so user code can't crash the run. The `correctors` registry itself is mutable module-global (`registerAppCorrectors` merges); CLI is one-shot so this is fine, but a long-lived engine-mode host that loads multiple unrelated apps in one process would leak — if that pattern ever matters, plumb the registry through `RunGenOptions` rather than mutating the global.
- **Corrector error-severity issues feed the repair loop (RED-275).** `runner.ts` now fires one additional repair attempt when `handleCorrect` returns `meta.issues` containing any `severity: 'error'` entry — mirrors the existing grounding path. A new `ValidateAfterCorrectorRepair` trace step is emitted on the re-validation.
- **Every repair-step push goes through `pushRepairStep(repair)` (RED-280).** Five repair sites exist in `runGen` (schema-repair loop, Review, Consensus, corrector feedback, grounding) and they used to drift — three called `trace.steps.push + budgetTrack` while Consensus and grounding silently bare-pushed, leaking the token spend past the budget gate. The helper at the top of `runGen` encapsulates the pair so a sixth call site can't reintroduce the bug. If you add a new repair-driven trace step, route it through `pushRepairStep`; never write `trace.steps.push(repair.result)` in runner.ts without also calling `budgetTrack`.
- **`grounded_in :name` source must match `/^[a-z][a-z0-9_]*$/` (RED-283).** `ruby/cambium/runtime.rb#grounded_in` raises `ArgumentError` on any source symbol that doesn't match — joining the regex list that already covers pack names (RED-214), pool names (RED-215), memory keys + `CAMBIUM_SESSION_ID` (RED-215 phase 3), scaffolded tool names (RED-216), and app-corrector basenames (RED-275). The source flows into `ir.context[<source>]` (RED-276) and into the prompt's DOCUMENT: section; rejecting oddly-shaped keys at compile time prevents brittle IRs (`__proto__`, `"has space"`, `CamelCase`).
- **Memory pools are authoritative on `strategy`/`embed`/`keyed_by`/`retain` (RED-215, extended RED-239).** When a gen does `memory :x, scope: :named_pool`, those four slots come from the pool; attempting to set any of them at the gen site is a compile error. Reader knobs (`size`, `top_k`) stay on the memory decl. Enforced by `MemoryPool::POOL_OWNED_SLOTS` + the resolution loop in `compile.rb`. Same per-slot "exactly one source" stance as RED-214, applied per-decl rather than across a primitive. If `retain` ever needs to be "tightenable" on the gen side, that requires a new `POOL_TIGHTENABLE_SLOTS` concept — don't just remove `retain` from the owned list.
- **Memory TTLs are bounded at both ends (RED-239).** `Retention.parse_duration!` rejects zero durations (silent no-op hides misconfigurations) AND values above 10 years (TS `Date.now() - ttl * 1000` overflows `Number.MAX_SAFE_INTEGER` near that horizon and crashes `toISOString()`). The 10-year cap is documented in `runtime.rb` as `MAX_TTL_SECONDS`. Don't widen it without also widening the TS arithmetic.
- **Prune runs in one transaction (RED-239).** `SqliteMemoryBackend.prune` wraps both the TTL-delete and the cap-delete phases in a single outer `db.transaction(...)`. An abnormal process exit mid-prune leaves the bucket in its pre-prune state — never half-pruned. Do not split the two phases into separate transactions.
- **Workspace memory policy is enforced at compile time, never overridable per-gen (RED-239 v2).** `app/config/memory_policy.rb` (optional file) declares `max_ttl`/`default_ttl`/`max_entries`/`ban_scope`/`require_keyed_by_for`/`allowed_pools`; `Cambium::MemoryPolicy.apply!` runs at the end of memory resolution in `compile.rb` and raises `CompileError` on any violation. There is no per-gen escape hatch — matches the RED-214 policy-pack stance that "policy is policy." Defaults (`default_ttl`) are applied BEFORE enforcement so a default-filled retain still trips `max_ttl` if it would violate it, and `default_ttl ≤ max_ttl` is validated at policy load. Pools are checked before decls so pool-source-of-truth errors surface with the pool's name, not the decl's.
- **Memory `--memory-key` values AND `CAMBIUM_SESSION_ID` are both restricted to `/^[a-zA-Z0-9_\-]+$/` with a 128-char max (RED-215 phase 3).** Both flow into `node:path.join` as directory segments under `runs/memory/<scope>/<key>/`; `node:path` normalises `..` rather than rejecting it, so the validator in `packages/cambium-runner/src/memory/keys.ts#validateSafeSegment` is the only guard. Don't relax the regex or length cap without adding an explicit sanitizer at the path-join site. Backend handles are also registered in `process.once('exit', ...)` in `runner.ts` so every exit path flushes SQLite WAL cleanly.
- **`:semantic` memory is a plan-time error, not a silent no-op (RED-215 phase 3).** `planMemory` throws on any `:semantic` decl with a "phase 5" message. Silent skip would hide broken gens; the error forces the author to either remove the decl or wait for phase 5.
- **Memory writes are post-success only.** `commitMemoryWrites` only fires when `finalOk === true`. A failed validation/repair run does not append to the log. This preserves "memory reflects what the gen actually produced" — otherwise retries would pile junk entries.
- **Retro-agent failures never fail the primary run (RED-215 phase 4).** Every failure path in `runner.ts`'s retro-agent block — agent file not found, subprocess crash, output not parseable, `writes[]` missing, unknown-memory-slot writes — emits a trace step with `ok: false` and proceeds. The primary has already returned a valid answer; memory loss is graceful degradation. If you find yourself wanting to throw instead of trace, write a new invariant note first explaining why this case is different.
- **Retro agents always enter via `remember(ctx)` (RED-215 phase 4).** This is Cambium's ActiveJob#perform convention. Don't make it configurable. The agent's class name is resolved from `write_memory_via :ClassName` → `classNameToFileBase` → `<snake_case>.cmb.rb` under the primary's `app/gens/` sibling or the workspace default. Search logic lives in `packages/cambium-runner/src/memory/retro-agent.ts#findRetroAgentFile`.
- **`mode :retro` suppresses memory machinery for that gen (RED-215 phase 4).** The guard in `runner.ts` (`const memoryDecls = isRetroMode ? [] : ...`) prevents a retro agent from triggering its own memory reads/writes — both because it doesn't make sense semantically and because a retro agent accidentally declaring `write_memory_via` would otherwise recurse.
- **Memory deps are `optionalDependencies` (RED-215 phase 5).** `better-sqlite3` and `sqlite-vec` are loaded via `await import(...)` inside `packages/cambium-runner/src/memory/backend.ts`. A gen that doesn't declare `memory :...` never triggers the import. A gen that does and can't load the deps gets a clear "install with: npm install better-sqlite3 sqlite-vec" error at plan time. Keep the runtime import path lazy — moving these back to static imports would break installs where the native binaries can't build.
- **sqlite-vec extension loads are per-connection (RED-215 phase 5).** Every `SqliteMemoryBackend` instance that touches `entries_vec` must call `initSemantic` first. The module handle is cached via `loadSqliteVec()` but the actual `sqliteVec.load(db)` runs once per `Database` instance, tracked by `_vecLoaded`. Meta pinning (embed_model, embed_dim) is one-time; the extension load is every-connection. This caught us during phase 5 integration testing — a second run opened the bucket, saw meta was already set, skipped the load, and then crashed on `SELECT ... FROM entries_vec`.
- **Embed model pinning is a correctness invariant, not best-effort (RED-215 phase 5).** `initSemantic` rejects a model or dim change with a clear error; the primary run fails (not "best-effort trace"). Mixed-model vectors in one bucket would scramble cosine-distance semantics silently. If a model change is intentional, delete the bucket or use a new memory `name`.
- **Model aliases are resolved at compile time, never at run time (RED-237).** `Cambium::ModelAliases` loads `app/config/models.rb` during Ruby compile and rewrites every `model :symbol` / `embed: :symbol` / bare-name string into its literal `"provider:name"` form before IR emission. The TS runner never sees a Symbol. Don't add runtime alias resolution — it would split the source of truth across two layers and break the "IR is truth" stance. If you need runtime model selection (env override, A/B), do it at IR-post-processing or add a separate mechanism; don't reuse aliases.
- **Tool plugin precedence: plugin handler wins over builtin (RED-209).** `handleToolCall` resolves `registry.getHandler(toolName) ?? builtinTools[toolName]`. A plugin tool in `app/tools/<name>.tool.ts` shadowing a same-named framework builtin is the intended override hook, but it's also a silent invariant-weakening risk — a plugin that bypasses `ctx.fetch` would re-open SSRF. New plugin tools must declare `permissions` honestly in their `.tool.json` and go through `ctx.fetch` for any network access. `cambium-security` reviews flag plugins that miss either.
- **Budget check is the strict first gate.** In `handleToolCall`, `env.budget?.checkBeforeCall` runs before impl resolution, before `ToolContext` construction, before anything else. Reordering this — even if the reorder doesn't functionally bypass the cap — means budget violations no longer surface first in the trace, which breaks observability guarantees.
- **Action dispatch mirrors tool dispatch (RED-212).** `dispatchAction` in `packages/cambium-runner/src/triggers.ts` runs `env.budget?.checkBeforeCall` → resolve def/handler → `buildToolContext` → `handler(input, ctx)` in that order, same as `handleToolCall`. Skipping the budget pre-call or passing a bare `globalThis.fetch` instead of `ctx.fetch` would open the same holes. Unknown-action triggers MUST fail fast at runner startup (not at signal-fire time) — the check is in `runner.ts` right after `ActionRegistry` loads. Don't defer it.

### Tracking

Cambium work is tracked in Linear. Team: **RED** (Redwood Labs), project: **Cambium**. Branch naming: `RED-<NNN>/<short-slug>`. Commit subjects: `RED-<NNN>: <message>`.
