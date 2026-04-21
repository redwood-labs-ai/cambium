# @redwood-labs/cambium-runner

TypeScript runtime for [Cambium](https://source.deerlarch.net/sbkeider/cambium) — executes compiled IR produced by the Cambium Ruby DSL.

This is the **library** form. For the `cambium` CLI (authoring `.cmb.rb` files, scaffolders, `cambium run`), install the `cambium` package instead.

## Install

```bash
npm install @redwood-labs/cambium-runner
```

## Use (engine mode)

Host projects import `runGen` and supply their own schemas:

```ts
import { runGen } from '@redwood-labs/cambium-runner';
import * as schemas from './schemas.js';

// `ir` is the JSON IR emitted by the Ruby compiler (or constructed programmatically).
const result = await runGen({ ir, schemas, mock: false });

if (result.ok) {
  console.log(result.output);
  console.log('Trace:', result.trace);
}
```

### Options

```ts
await runGen({
  ir,                // IR object
  schemas,           // Record<string, JSONSchema7> — single source of truth for validation
  mock: false,       // use deterministic mock instead of live LLM
  memoryKeys: [],    // `--memory-key name=value` slot values
  sessionId,         // explicit session id for memory :session scope
  correctors,        // Record<string, CorrectorFn> — override built-ins or add plugins
  logSinks,          // Record<string, LogSink>   — override built-ins or add plugins
  firedBy,           // 'schedule:<id>[@<iso>]' — when invoked by a cron fire
});
```

### Types

```ts
import type {
  RunGenOptions, RunGenResult,
  CorrectorFn, CorrectorResult, CorrectorIssue,
  ToolContext,
  LogEvent, LogSink, LogDestination, RunEventName, FailReason,
} from '@redwood-labs/cambium-runner';
```

## Compiling IR

The IR is produced by the Cambium Ruby compiler (`ruby/cambium/compile.rb`), which ships with the `cambium` CLI package. Engine-mode hosts typically commit a compiled `<name>.ir.json` alongside each gen and import that — or shell out to `cambium compile <file.cmb.rb>` as a build step.

## Internal exports

`@redwood-labs/cambium-runner` also exports `runGenFromIr` / `RunGenFromIrOptions` / `RunGenFromIrResult`. These are the in-process CLI-orchestration helpers used by the `cambium` binary — they wrap schema discovery (engine-mode sibling `schemas.ts` or app-mode `Genfile.toml [types].contracts`) plus artifact writes around `runGen`. **Engine-mode library consumers should call `runGen` directly**; `runGenFromIr` assumes a filesystem layout the host already controls explicitly.

## Optional dependencies

Memory (`better-sqlite3`, `sqlite-vec`) and the WASM exec substrate (`quickjs-emscripten`) are declared as `optionalDependencies`. Gens that don't declare `memory :...` or `security exec: { runtime: :wasm }` never trigger the import; installs without those native builds succeed without penalty.

## License

MIT — see [`LICENSE`](LICENSE).
