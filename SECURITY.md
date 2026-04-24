# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Cambium, please report it privately rather than opening a public issue.

**Contact:** security@redwoodlabs.ai

Please include:

- A description of the issue and the packages / versions affected.
- Reproduction steps or a minimal proof-of-concept.
- Your assessment of impact and severity.

I aim to acknowledge receipt within 72 hours and to have a fix, mitigation, or disclosure timeline agreed within 14 days for confirmed vulnerabilities. Once a fix is released, the reporter is credited in the release notes unless they prefer to remain anonymous.

## Supported Versions

Cambium is in pre-1.0 active development. Only the latest minor release receives security patches.

| Version | Supported |
| --- | --- |
| 0.1.x   | ✓         |
| < 0.1   | ✗         |

When a new minor ships (0.2.x), the previous minor receives one more month of security patches and is then out of support.

## Scope

This policy covers:

- `@redwood-labs/cambium` (CLI)
- `@redwood-labs/cambium-runner` (library)

Not covered by this policy:

- User-authored gens, tools, correctors, policies, memory pools, or log profiles. Their security posture is your responsibility.
- LLM provider services that Cambium connects to (oMLX, Ollama, etc.). Report issues there to the provider.
- Third-party npm packages that Cambium depends on. Report those to their maintainers. If the vulnerability is exploitable *through* Cambium, also report it here so we can release an advisory and a version bump.

## Security Posture

Cambium is developed and maintained by a single author under the Redwood Labs umbrella. To keep the supply chain auditable, the project takes the following positions:

### Lean direct dependencies

Runtime dependencies are intentionally limited to well-known, widely-adopted packages from long-standing maintainers:

- `@sinclair/typebox` (schema definition)
- `ajv` (schema validation)
- `undici` (HTTP client — official Node.js)
- `dotenv` (env loading, CLI only)
- `smol-toml` (TOML parser, CLI only)
- `tsx` (user-TS loader, CLI only)

Native-build optional dependencies (`better-sqlite3`, `sqlite-vec`) are tilde-pinned (`~x.y.z`) so only patch updates flow through automatically; minor or major bumps require an explicit Cambium release after testing.

The full dependency list and exact versions are in each package's `package.json`.

### No telemetry

Cambium does not phone home at install, compile, or run time. There are no analytics, no update checks, no crash reports sent anywhere. Every network request is either to an LLM provider you configured, to an observability endpoint you declared via the `log` primitive, or initiated by a gen you authored.

### Tool sandbox

Cambium's built-in tools enforce a network / filesystem / exec permission model at the dispatch boundary, with SSRF guards and IP pinning. User-authored tools go through the same `ctx.fetch` path for network access. See [`docs/GenDSL Docs/S - Tool Sandboxing (RED-137).md`](docs/GenDSL%20Docs/S%20-%20Tool%20Sandboxing%20%28RED-137%29.md) for details.

For code execution (`execute_code` tool), three substrates are available:

- **`:native`** — no isolation. Emits a `tool.exec.unsandboxed` trace step and a one-per-run stderr warning. `CAMBIUM_STRICT_EXEC=1` promotes this to a compile error.
- **`:wasm`** — QuickJS on WebAssembly. Memory and wall-clock limits enforced. No filesystem or network preopens.
- **`:firecracker`** — micro-VM isolation with explicit filesystem allowlist, per-call netns, and network allowlist. See [`docs/GenDSL Docs/S - Tool Exec Sandboxing (RED-213).md`](docs/GenDSL%20Docs/S%20-%20Tool%20Exec%20Sandboxing%20%28RED-213%29.md) for the threat model.

### Publishing

- npm publishing uses an account with 2FA enabled (auth-and-writes).
- Releases are published manually from a trusted machine. Automated CI-driven publishing with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) is planned for a future release.
- A pre-publish structural check (`scripts/pre-publish-check.mjs`, runnable via `npm run pre-publish-check`) packs real tarballs, installs them into a realistic consumer project with other deps, and asserts: no `workspaces` field in the published manifest; no workspace-source / shrinkwrap leaks into the tarball; `cambium/` and `cambium-runner/` install as peer packages (no nested shell); CLI bin runs; library imports resolve. Must pass before every publish.

## Security-relevant design documents

If you are evaluating Cambium's threat model or doing a security review, the following notes are the primary references:

- [`S - Tool Sandboxing (RED-137)`](docs/GenDSL%20Docs/S%20-%20Tool%20Sandboxing%20%28RED-137%29.md) — network egress guard, IP pinning, dispatch-site permission checks.
- [`S - Tool Exec Sandboxing (RED-213)`](docs/GenDSL%20Docs/S%20-%20Tool%20Exec%20Sandboxing%20%28RED-213%29.md) — code-execution substrates (`:native`, `:wasm`, `:firecracker`).
- `CLAUDE.md` ("Non-obvious invariants" → security clusters) — invariants that, if violated, reopen known attack surfaces.

## Public disclosure

Confirmed vulnerabilities are disclosed via:

- A patch release (`0.1.x`) with the fix.
- A `CHANGELOG.md` entry describing the issue, affected versions, and required upgrade.
- A GitHub Security Advisory once the public GitHub mirror is live.

Reporters are credited unless they prefer anonymity.
