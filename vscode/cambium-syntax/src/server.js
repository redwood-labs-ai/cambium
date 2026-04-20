const {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  CompletionItemKind,
  MarkupKind,
} = require('vscode-languageserver/node');
const { TextDocument } = require('vscode-languageserver-textdocument');
const fs = require('fs');
const path = require('path');

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// ── Workspace scanning ────────────────────────────────────────────────

let workspaceRoot = '';
let systemPrompts = {};  // name → { path, content }
let toolDefs = {};       // name → { path, description }
let actionDefs = {};     // name → { path, description }              -- RED-212
let correctorFiles = {}; // name → { path, origin: 'framework' | 'app' }
let schemaExports = {};  // name → { path, line }
let signalDefs = {};     // name → line (per-file extract declarations)
let policyPacks = {};    // name → { path, content }                  -- RED-214
let memoryPools = {};    // name → { path, content }                  -- RED-215
let modelAliases = {};   // alias → { path, line, value }             -- RED-237

function scanWorkspace() {
  if (!workspaceRoot) return;

  // Reset state — scans rebuild from disk on every `onDidChangeContent`.
  systemPrompts = {};
  toolDefs = {};
  actionDefs = {};
  correctorFiles = {};
  schemaExports = {};
  policyPacks = {};
  memoryPools = {};
  modelAliases = {};

  // Scan system prompts
  const systemsDir = path.join(workspaceRoot, 'packages/cambium/app/systems');
  if (fs.existsSync(systemsDir)) {
    for (const f of fs.readdirSync(systemsDir)) {
      if (!f.endsWith('.system.md')) continue;
      const name = f.replace('.system.md', '');
      const fullPath = path.join(systemsDir, f);
      const content = fs.readFileSync(fullPath, 'utf8').trim();
      systemPrompts[name] = { path: fullPath, content };
    }
  }

  // Scan policy packs (RED-214)
  const policiesDir = path.join(workspaceRoot, 'packages/cambium/app/policies');
  if (fs.existsSync(policiesDir)) {
    for (const f of fs.readdirSync(policiesDir)) {
      if (!f.endsWith('.policy.rb')) continue;
      const name = f.replace('.policy.rb', '');
      const fullPath = path.join(policiesDir, f);
      const content = fs.readFileSync(fullPath, 'utf8').trim();
      policyPacks[name] = { path: fullPath, content };
    }
  }

  // Scan memory pools (RED-215)
  const poolsDir = path.join(workspaceRoot, 'packages/cambium/app/memory_pools');
  if (fs.existsSync(poolsDir)) {
    for (const f of fs.readdirSync(poolsDir)) {
      if (!f.endsWith('.pool.rb')) continue;
      const name = f.replace('.pool.rb', '');
      const fullPath = path.join(poolsDir, f);
      const content = fs.readFileSync(fullPath, 'utf8').trim();
      memoryPools[name] = { path: fullPath, content };
    }
  }

  // Scan tool definitions
  const toolsDir = path.join(workspaceRoot, 'packages/cambium/app/tools');
  if (fs.existsSync(toolsDir)) {
    for (const f of fs.readdirSync(toolsDir)) {
      if (!f.endsWith('.tool.json')) continue;
      const name = f.replace('.tool.json', '');
      const fullPath = path.join(toolsDir, f);
      try {
        const def = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        toolDefs[name] = { path: fullPath, description: def.description ?? '' };
      } catch {}
    }
  }

  // Scan action definitions (RED-212)
  const actionsDir = path.join(workspaceRoot, 'packages/cambium/app/actions');
  if (fs.existsSync(actionsDir)) {
    for (const f of fs.readdirSync(actionsDir)) {
      if (!f.endsWith('.action.json')) continue;
      const name = f.replace('.action.json', '');
      const fullPath = path.join(actionsDir, f);
      try {
        const def = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        actionDefs[name] = { path: fullPath, description: def.description ?? '' };
      } catch {}
    }
  }

  // Scan framework correctors (RED-242 moved these to packages/cambium-runner/).
  const fwCorrectorsDir = path.join(workspaceRoot, 'packages/cambium-runner/src/correctors');
  if (fs.existsSync(fwCorrectorsDir)) {
    for (const f of fs.readdirSync(fwCorrectorsDir)) {
      if (f.endsWith('.test.ts') || f === 'index.ts' || f === 'types.ts') continue;
      if (!f.endsWith('.ts')) continue;
      const name = f.replace('.ts', '');
      correctorFiles[name] = { path: path.join(fwCorrectorsDir, f), origin: 'framework' };
    }
  }

  // Scan app correctors (RED-275). App wins on name collision, matching
  // the runtime's registerAppCorrectors override behavior.
  const appCorrectorsDir = path.join(workspaceRoot, 'packages/cambium/app/correctors');
  if (fs.existsSync(appCorrectorsDir)) {
    for (const f of fs.readdirSync(appCorrectorsDir)) {
      if (!f.endsWith('.corrector.ts')) continue;
      const name = f.replace('.corrector.ts', '');
      correctorFiles[name] = { path: path.join(appCorrectorsDir, f), origin: 'app' };
    }
  }

  // Scan schema exports from contracts.ts
  const contractsPath = path.join(workspaceRoot, 'packages/cambium/src/contracts.ts');
  if (fs.existsSync(contractsPath)) {
    const lines = fs.readFileSync(contractsPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^export const (\w+)\s*=/);
      if (m) {
        schemaExports[m[1]] = { path: contractsPath, line: i };
      }
    }
  }

  // Scan model aliases (RED-237) from app/config/models.rb.
  // Each alias is a top-level call: `default "omlx:Qwen3.5-27B-4bit"`.
  const modelsPath = path.join(workspaceRoot, 'packages/cambium/app/config/models.rb');
  if (fs.existsSync(modelsPath)) {
    const lines = fs.readFileSync(modelsPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Skip comments + blank lines.
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const m = trimmed.match(/^([a-z][a-z0-9_]*)\s+"([^"]+)"/);
      if (m) {
        modelAliases[m[1]] = { path: modelsPath, line: i, value: m[2] };
      }
    }
  }
}

// ── Primitive documentation ───────────────────────────────────────────

const PRIMITIVE_DOCS = {
  model: {
    detail: 'Declares the LLM provider and model.',
    doc: 'Two forms.\n\nLiteral: `provider:model_name` (e.g., `"omlx:Qwen3.5-27B-4bit"`).\n\nAlias (RED-237): `model :default` resolves through `app/config/models.rb` at compile time to a literal provider-prefixed id. The runner never sees the symbol.',
  },
  system: {
    detail: 'Declares the system prompt.',
    doc: 'Symbol resolves to `app/systems/<name>.system.md`.\nString is used inline.\n\n```ruby\nsystem :analyst      # loads from file\nsystem "You are..." # inline\n```',
  },
  temperature: {
    detail: 'Sets the sampling temperature.',
    doc: 'Lower = more deterministic, higher = more creative.\nTypical range: 0.0 - 1.0.',
  },
  max_tokens: {
    detail: 'Sets the maximum output tokens.',
    doc: 'Caps the model\'s response length. Affects cost and output completeness.',
  },
  returns: {
    detail: 'Declares the return schema (TypeBox contract).',
    doc: 'Must match a `$id` in `src/contracts.ts`.\nOutput is validated against this schema with AJV.\n\n```ruby\nreturns AnalysisReport\n```',
  },
  uses: {
    detail: 'Declares allowed tools (deny-by-default).',
    doc: 'Tools must be defined in `app/tools/<name>.tool.json`.\nUndeclared tools cannot be called.\nEvery tool call is logged in the trace.\n\n```ruby\nuses :calculator, :file_read\n```',
  },
  corrects: {
    detail: 'Attaches deterministic correctors.',
    doc: 'Run after validation, before triggers.\nBuilt-in: `:math`, `:dates`, `:currency`, `:citations`.\n\n```ruby\ncorrects :math, :dates\n```',
  },
  constrain: {
    detail: 'Declares a runtime constraint.',
    doc: 'Constraints change runtime behavior without changing the DSL.\n\n```ruby\nconstrain :tone, to: :professional\nconstrain :compound, strategy: :review\nconstrain :consistency, passes: 2\nconstrain :budget, max_tool_calls: 10\n```',
  },
  extract: {
    detail: 'Declares a typed signal extraction from the output.',
    doc: 'Signals are extracted after validation.\nUsed by triggers to fire tool calls or agent actions.\n\n```ruby\nextract :latency_ms, type: :number, path: "metrics.latency_ms_samples"\n```',
  },
  on: {
    detail: 'Declares a deterministic trigger.',
    doc: 'Fires when the named signal has values.\nThe model never decides to call a tool — signals drive triggers.\n\n```ruby\non :latency_ms do\n  tool :calculator, operation: "avg", target: "metrics.avg_latency_ms"\nend\n```',
  },
  generate: {
    detail: 'Executes a governed generation transaction.',
    doc: 'A `generate` block is a transaction with validate/repair/trace.\nNot an opaque LLM call.\n\n```ruby\ngenerate "analyze this document" do\n  with context: document\n  returns AnalysisReport\nend\n```',
  },
  grounded_in: {
    detail: 'Enforces citations grounded in a source document.',
    doc: 'When `require_citations: true`, all claim items must include verbatim quotes.\nFabricated citations are flagged and repaired.\n\n```ruby\ngrounded_in :document, require_citations: true\n```',
  },
  enrich: {
    detail: 'Pre-generate context enrichment via sub-agent.',
    doc: 'Delegates raw context to a sub-agent for summarization before the main generate.\nOriginal context preserved; enriched output added alongside.\n\n```ruby\nenrich :document do\n  agent :LogSummarizer, method: :summarize\nend\n```',
  },
  mode: {
    detail: 'Controls the execution strategy for generate.',
    doc: '`mode :agentic` — multi-turn tool-use loop. Model calls tools, gets results, iterates.\n\n`mode :retro` (RED-215 phase 4) — retro memory agent. Reads a primary gen\'s trace and returns `MemoryWrites` rather than the primary\'s schema. Combined with `reads_trace_of :Primary`.\n\n```ruby\nmode :agentic\nmode :retro\n```',
  },
  repair: {
    detail: 'Configures the repair policy for validation failures.',
    doc: 'Controls how the runner retries when output fails validation.\n\n```ruby\nrepair max_attempts: 3, stop_on_no_improvement: true\n```\n\n`max_attempts` — max repair iterations (default: from `policies.max_repair_attempts`)\n`stop_on_no_improvement` — halt if error count doesn\'t decrease',
  },
  security: {
    detail: 'Configures tool-execution security policy (RED-137 / RED-214 / RED-248+).',
    doc: 'Two forms.\n\nInline:\n```ruby\nsecurity \\\n  network: {\n    allowlist: ["api.tavily.com"],\n    block_private: true,   # default\n    block_metadata: true,  # default\n  },\n  filesystem: {\n    allowlist_paths: ["/data/in"]   # RED-258 — replaces roots:\n  },\n  exec: {\n    runtime: :wasm,       # :wasm | :firecracker | :native (deprecated)\n    language: :javascript,\n    timeout: 30,\n    memory: 256,\n    cpu: 1\n  }\n```\n\nFrom a policy pack (RED-214) — resolves to `app/policies/<name>.policy.rb`:\n```ruby\nsecurity :research_defaults\n```\n\nMixing rule: each slot (network/filesystem/exec) can be set by exactly one source. Pack OR inline OK; both touching the same slot is a compile error.\n\nExec substrates: `:wasm` (RED-254, QuickJS-WASM), `:firecracker` (RED-251+, microVM with optional filesystem/network allowlists), `:native` (deprecated; unsandboxed).',
  },
  budget: {
    detail: 'Per-tool and per-run call budgets (RED-137 / RED-214).',
    doc: 'Two forms.\n\nInline:\n```ruby\nbudget \\\n  per_tool: { tavily: { max_calls: 5 } },\n  per_run:  { max_calls: 100 }\n```\n\nFrom a policy pack (RED-214):\n```ruby\nbudget :research_defaults\n```\n\nSame per-slot mixing rule as `security`. v1 supports `max_calls` only; token/USD deferred.',
  },
  with: {
    detail: 'Passes context into a generate block.',
    doc: 'Keyword arguments become context fields available during generation.\n\n```ruby\nwith context: document\n```',
  },
  tool: {
    detail: 'Queues a tool call inside a trigger block.',
    doc: 'Executes a registered tool when the trigger fires.\n\n```ruby\ntool :calculator, operation: "avg", target: "metrics.avg_latency_ms"\n```',
  },
  action: {
    detail: 'Dispatches a trigger action (RED-212).',
    doc: 'Parallel to `tool`, but for side-effect handlers (notifications, webhooks, Linear/Slack integrations) rather than data transforms. Declared at `app/actions/<name>.action.{json,ts}` and auto-discovered by the action registry.\n\n```ruby\non :latency_ms do\n  action :slack_notify, message: "latency spike detected"\nend\n```',
  },
  memory: {
    detail: 'Declares a memory slot (RED-215).',
    doc: 'Per-gen memory bucket. The runner reads from it before `Generate` (injecting as a `## Memory` block in the system prompt) and writes to it after a successful run.\n\nThree strategies:\n```ruby\nmemory :conversation, strategy: :sliding_window, size: 20\nmemory :facts, strategy: :semantic, top_k: 5, embed: "omlx:bge-small-en"\nmemory :activity, strategy: :log                 # append-only, no read\n```\n\nScopes: `:session` (default, auto-generated id), `:global` (shared across runs), or a named pool (`scope: :support_team`) defined at `app/memory_pools/<name>.pool.rb`. Pool-scoped memory inherits `strategy` / `embed` / `keyed_by` from the pool (authoritative); the gen-site decl can only set reader knobs (`size`, `top_k`).\n\nWith `retain` (RED-239):\n```ruby\nmemory :conversation, strategy: :sliding_window, size: 20,\n       retain: { ttl: "7d", max_entries: 1000 }\n```',
  },
  memory_pool: {
    detail: 'Named memory pool (RED-215).',
    doc: 'Pool files live at `app/memory_pools/<name>.pool.rb` and declare the authoritative shape for any gen that opts in via `memory :slot, scope: :pool_name`.\n\n```ruby\n# app/memory_pools/support_team.pool.rb\nstrategy :semantic\nembed    "omlx:bge-small-en"\nkeyed_by :team_id\nretain   ttl: "30d"\n```\n\nPools own `strategy` / `embed` / `keyed_by` / `retain`; gen-site decls can only tighten reader knobs. Enforced by `MemoryPool::POOL_OWNED_SLOTS`.',
  },
  write_memory_via: {
    detail: 'Routes memory writes through a retro agent (RED-215 phase 4).',
    doc: 'After a successful primary run, the runner invokes the named retro agent\'s `remember(ctx)` method (ActiveJob#perform analogue). The retro agent returns `MemoryWrites` with explicit `writes: [{ memory:, content: }]` entries, giving you full control over what lands in the bucket.\n\n```ruby\nwrite_memory_via :SupportMemoryAgent\n```\n\nRetro agent shape:\n```ruby\nclass SupportMemoryAgent < GenModel\n  mode :retro\n  reads_trace_of :SupportAnalyst\n  returns MemoryWrites\nend\n```\n\nFailures never propagate to the primary — best-effort writes emit `memory.write ok:false` trace steps.',
  },
  reads_trace_of: {
    detail: 'Retro agent trace access (RED-215 phase 4).',
    doc: 'Declares which primary gen\'s trace this retro agent reads. Paired with `mode :retro`. The runner builds the retro-agent context from the primary\'s trace (steps, signals, output) before invoking `remember(ctx)`.\n\n```ruby\nclass SupportMemoryAgent < GenModel\n  mode :retro\n  reads_trace_of :SupportAnalyst\n  returns MemoryWrites\nend\n```',
  },
  retain: {
    detail: 'Memory retention policy (RED-239).',
    doc: 'TTL + entry-cap on a memory bucket. Applied at prune time (invoked before every read to keep buckets honest).\n\n```ruby\nmemory :facts, strategy: :semantic, top_k: 5,\n       retain: { ttl: "30d", max_entries: 10_000 }\n```\n\nBoth bounds optional; `ttl` accepts `"30d" / "12h" / "3600s"` / `Integer` seconds. TTL zero and values above 10 years both rejected at compile time. A workspace-level `app/config/memory_policy.rb` can cap `max_ttl` / `default_ttl` / `max_entries` across all decls.',
  },
};

// ── Hover ─────────────────────────────────────────────────────────────

connection.onHover((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const line = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: { line: params.position.line, character: 1000 },
  });

  const pos = params.position.character;
  const word = getWordAt(line, pos);
  if (!word) return null;

  // Check if hovering over a DSL primitive
  const prim = PRIMITIVE_DOCS[word];
  if (prim) {
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** — ${prim.detail}\n\n${prim.doc}`,
      },
    };
  }

  // Check if hovering over a symbol (:name)
  const symbolMatch = line.match(new RegExp(`:${word}\\b`));
  if (symbolMatch) {
    // System prompt reference
    if (systemPrompts[word]) {
      const sp = systemPrompts[word];
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**:${word}** — System prompt\n\n*${sp.path}*\n\n---\n\n${sp.content}`,
        },
      };
    }

    // Tool reference
    if (toolDefs[word]) {
      const td = toolDefs[word];
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**:${word}** — Tool\n\n*${td.path}*\n\n${td.description}`,
        },
      };
    }

    // Corrector reference (RED-275: framework built-ins + app plugins share the map).
    if (correctorFiles[word]) {
      const cf = correctorFiles[word];
      const label = cf.origin === 'app' ? 'App corrector' : 'Framework corrector';
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**:${word}** — ${label}\n\n*${cf.path}*`,
        },
      };
    }

    // Memory pool reference (RED-215) — only meaningful after `scope: :`
    // inside a memory decl. Gated to avoid collision with tool/corrector symbols.
    if (memoryPools[word] && /\bscope:\s*:/.test(line)) {
      const mp = memoryPools[word];
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**:${word}** — Memory pool\n\n*${mp.path}*\n\n---\n\n\`\`\`ruby\n${mp.content}\n\`\`\``,
        },
      };
    }

    // Action reference (RED-212) — only meaningful after `action :`.
    if (actionDefs[word] && /\baction\s+:/.test(line)) {
      const ad = actionDefs[word];
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**:${word}** — Trigger action\n\n*${ad.path}*\n\n${ad.description}`,
        },
      };
    }

    // Model alias reference (RED-237) — only meaningful after `model :`.
    if (modelAliases[word] && /\bmodel\s+:/.test(line)) {
      const ma = modelAliases[word];
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**:${word}** — Model alias → \`${ma.value}\`\n\n*${ma.path}:${ma.line + 1}*`,
        },
      };
    }

    // Policy pack reference (RED-214) — only meaningful after `security`
    // or `budget`; otherwise the symbol could collide with a tool/corrector.
    if (policyPacks[word] && /^\s*(security|budget)\s+:/.test(line)) {
      const pp = policyPacks[word];
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**:${word}** — Policy pack\n\n*${pp.path}*\n\n---\n\n\`\`\`ruby\n${pp.content}\n\`\`\``,
        },
      };
    }
  }

  // Check if hovering over a schema constant (PascalCase)
  if (word[0] === word[0].toUpperCase() && schemaExports[word]) {
    const se = schemaExports[word];
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `**${word}** — TypeBox schema\n\n*${se.path}:${se.line + 1}*`,
      },
    };
  }

  return null;
});

// ── Go to definition ──────────────────────────────────────────────────

connection.onDefinition((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  const line = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: { line: params.position.line, character: 1000 },
  });

  const pos = params.position.character;
  const word = getWordAt(line, pos);
  if (!word) return null;

  // Symbol → file
  if (systemPrompts[word]) {
    return { uri: 'file://' + systemPrompts[word].path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  }
  if (toolDefs[word]) {
    return { uri: 'file://' + toolDefs[word].path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  }
  if (correctorFiles[word]) {
    return { uri: 'file://' + correctorFiles[word].path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  }
  // Policy pack — only when called from a `security` or `budget` line
  // (RED-214). Other primitives can take colliding names without this.
  if (policyPacks[word] && /^\s*(security|budget)\s+:/.test(line)) {
    return { uri: 'file://' + policyPacks[word].path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  }
  // Memory pool — only after `scope: :` (RED-215).
  if (memoryPools[word] && /\bscope:\s*:/.test(line)) {
    return { uri: 'file://' + memoryPools[word].path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  }
  // Action — only after `action :` (RED-212).
  if (actionDefs[word] && /\baction\s+:/.test(line)) {
    return { uri: 'file://' + actionDefs[word].path, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
  }
  // Model alias — only after `model :` (RED-237). Takes you to the
  // specific line in models.rb that defines the alias.
  if (modelAliases[word] && /\bmodel\s+:/.test(line)) {
    const ma = modelAliases[word];
    return { uri: 'file://' + ma.path, range: { start: { line: ma.line, character: 0 }, end: { line: ma.line, character: 0 } } };
  }

  // Schema constant → contracts.ts line
  if (schemaExports[word]) {
    const se = schemaExports[word];
    return { uri: 'file://' + se.path, range: { start: { line: se.line, character: 0 }, end: { line: se.line, character: 0 } } };
  }

  // Extract signal → find the extract declaration in the same file
  const text = doc.getText();
  const extractMatch = text.match(new RegExp(`extract\\s+:${word}\\b`));
  if (extractMatch) {
    const offset = extractMatch.index;
    const beforeMatch = text.slice(0, offset);
    const lineNum = (beforeMatch.match(/\n/g) || []).length;
    return { uri: params.textDocument.uri, range: { start: { line: lineNum, character: 0 }, end: { line: lineNum, character: 0 } } };
  }

  return null;
});

// ── Completions ───────────────────────────────────────────────────────

connection.onCompletion((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  const line = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: { line: params.position.line, character: params.position.character },
  });

  // After "system :" → suggest system prompts
  if (/system\s+:/.test(line)) {
    return Object.keys(systemPrompts).map(name => ({
      label: name,
      kind: CompletionItemKind.Value,
      detail: systemPrompts[name].content.slice(0, 60) + '...',
      documentation: systemPrompts[name].content,
    }));
  }

  // After "security :" or "budget :" → suggest policy packs (RED-214)
  if (/(security|budget)\s+:/.test(line)) {
    return Object.keys(policyPacks).map(name => ({
      label: name,
      kind: CompletionItemKind.Value,
      detail: 'policy pack',
      documentation: policyPacks[name].content,
    }));
  }

  // After "uses :" → suggest tools
  if (/uses\s+.*:/.test(line)) {
    return Object.keys(toolDefs).map(name => ({
      label: name,
      kind: CompletionItemKind.Function,
      detail: toolDefs[name].description,
    }));
  }

  // After "corrects :" → suggest correctors (framework + app, RED-275).
  if (/corrects\s+.*:/.test(line)) {
    return Object.entries(correctorFiles).map(([name, cf]) => ({
      label: name,
      kind: CompletionItemKind.Function,
      detail: cf.origin === 'app' ? `App corrector: ${name}` : `Framework corrector: ${name}`,
    }));
  }

  // After "returns " → suggest schema names
  if (/returns\s+/.test(line)) {
    return Object.keys(schemaExports).map(name => ({
      label: name,
      kind: CompletionItemKind.Class,
      detail: `Schema: ${name}`,
    }));
  }

  // After "constrain :" → suggest constraint names
  if (/constrain\s+:/.test(line)) {
    return ['tone', 'compound', 'consistency', 'budget'].map(name => ({
      label: name,
      kind: CompletionItemKind.Property,
      detail: PRIMITIVE_DOCS.constrain?.detail,
    }));
  }

  // After "on :" → suggest signal names from extract declarations in the file
  if (/on\s+:/.test(line)) {
    const text = doc.getText();
    const signals = [];
    for (const m of text.matchAll(/extract\s+:(\w+)/g)) {
      signals.push(m[1]);
    }
    return signals.map(name => ({
      label: name,
      kind: CompletionItemKind.Event,
      detail: `Signal: ${name}`,
    }));
  }

  // After "mode :" → suggest modes
  if (/mode\s+:/.test(line)) {
    return [
      { label: 'agentic', kind: CompletionItemKind.EnumMember, detail: 'Multi-turn tool-use loop' },
      { label: 'retro',   kind: CompletionItemKind.EnumMember, detail: 'Retro memory agent (RED-215 phase 4)' },
    ];
  }

  // After "model :" → suggest aliases from app/config/models.rb (RED-237).
  if (/^\s*model\s+:/.test(line)) {
    return Object.entries(modelAliases).map(([name, ma]) => ({
      label: name,
      kind: CompletionItemKind.Value,
      detail: `→ ${ma.value}`,
    }));
  }

  // After "action :" → suggest action names (RED-212). Only applies inside
  // trigger blocks, but we don't do full parse-context detection — the
  // `action :` prefix is distinctive enough to avoid noise.
  if (/\baction\s+:/.test(line)) {
    return Object.entries(actionDefs).map(([name, ad]) => ({
      label: name,
      kind: CompletionItemKind.Function,
      detail: ad.description,
    }));
  }

  // After "write_memory_via :" → suggest gens that declare `mode :retro`
  // (RED-215 phase 4).
  if (/^\s*write_memory_via\s+:/.test(line)) {
    const retroAgents = [];
    const gensDir = path.join(workspaceRoot, 'packages/cambium/app/gens');
    if (fs.existsSync(gensDir)) {
      for (const f of fs.readdirSync(gensDir)) {
        if (!f.endsWith('.cmb.rb')) continue;
        const content = fs.readFileSync(path.join(gensDir, f), 'utf8');
        if (!/mode\s+:retro\b/.test(content)) continue;
        const classMatch = content.match(/class\s+(\w+)/);
        if (classMatch) {
          retroAgents.push({
            label: classMatch[1],
            kind: CompletionItemKind.Class,
            detail: `Retro agent from ${f}`,
          });
        }
      }
    }
    return retroAgents;
  }

  // After "scope: :" inside a memory decl → suggest memory pools (RED-215).
  if (/\bscope:\s*:/.test(line)) {
    return Object.entries(memoryPools).map(([name, mp]) => ({
      label: name,
      kind: CompletionItemKind.Value,
      detail: 'memory pool',
      documentation: mp.content,
    }));
  }

  // After "memory" at start of line → suggest memory kwargs.
  if (/^\s*memory\s+$/.test(line) || /^\s*memory\s+:\w+,\s*$/.test(line)) {
    return [
      { label: 'strategy:',   kind: CompletionItemKind.Property, detail: ':sliding_window | :semantic | :log' },
      { label: 'size:',       kind: CompletionItemKind.Property, detail: 'For :sliding_window — last N entries' },
      { label: 'top_k:',      kind: CompletionItemKind.Property, detail: 'For :semantic — nearest-neighbor count' },
      { label: 'embed:',      kind: CompletionItemKind.Property, detail: 'For :semantic — embedding model id' },
      { label: 'scope:',      kind: CompletionItemKind.Property, detail: ':session (default) | :global | :pool_name' },
      { label: 'keyed_by:',   kind: CompletionItemKind.Property, detail: 'Subkey for pool lookups' },
      { label: 'retain:',     kind: CompletionItemKind.Property, detail: '{ ttl: "30d", max_entries: 1000 } — RED-239' },
      { label: 'query:',      kind: CompletionItemKind.Property, detail: 'Literal query for :semantic — RED-238' },
      { label: 'arg_field:',  kind: CompletionItemKind.Property, detail: 'Pluck query from ctx.input JSON — RED-238' },
    ];
  }

  // After "enrich :" → suggest available agents from workspace scan
  if (/enrich\s+:/.test(line)) {
    // Scan for agent classes in the workspace
    const agentCompletions = [];
    const gensDir = path.join(workspaceRoot, 'packages/cambium/app/gens');
    if (fs.existsSync(gensDir)) {
      for (const f of fs.readdirSync(gensDir)) {
        if (!f.endsWith('.cmb.rb')) continue;
        const name = f.replace('.cmb.rb', '');
        const content = fs.readFileSync(path.join(gensDir, f), 'utf8');
        const classMatch = content.match(/class\s+(\w+)/);
        if (classMatch) {
          agentCompletions.push({
            label: classMatch[1],
            kind: CompletionItemKind.Class,
            detail: `Agent from ${f}`,
          });
        }
      }
    }
    return agentCompletions;
  }

  // After "repair" at start of line → suggest repair keywords
  if (/^\s*repair\s*$/.test(line)) {
    return [
      { label: 'max_attempts:', kind: CompletionItemKind.Property, detail: 'Max repair iterations' },
      { label: 'stop_on_no_improvement:', kind: CompletionItemKind.Property, detail: 'Halt if error count unchanged' },
    ];
  }

  // After "security" at start of line → suggest security keywords
  if (/^\s*security\s*$/.test(line)) {
    return [
      { label: 'network:',    kind: CompletionItemKind.Property, detail: 'Network egress policy { allowlist, denylist, block_private, block_metadata }' },
      { label: 'filesystem:', kind: CompletionItemKind.Property, detail: 'Filesystem policy { allowlist_paths } — RED-258' },
      { label: 'exec:',       kind: CompletionItemKind.Property, detail: 'Exec policy { runtime, language, cpu, memory, timeout } — RED-248/254/258/259' },
    ];
  }

  // After "budget" at start of line → suggest budget keywords
  if (/^\s*budget\s*$/.test(line)) {
    return [
      { label: 'per_tool:', kind: CompletionItemKind.Property, detail: 'Per-tool limits { toolname: { max_calls } }' },
      { label: 'per_run:',  kind: CompletionItemKind.Property, detail: 'Per-run limits { max_calls }' },
    ];
  }

  // Start of line → suggest primitives
  if (/^\s*$/.test(line) || /^\s+\w*$/.test(line)) {
    return Object.entries(PRIMITIVE_DOCS).map(([name, info]) => ({
      label: name,
      kind: CompletionItemKind.Keyword,
      detail: info.detail,
      documentation: { kind: MarkupKind.Markdown, value: info.doc },
    }));
  }

  return [];
});

// ── Helpers ───────────────────────────────────────────────────────────

function getWordAt(line, pos) {
  // Find the word at the cursor position
  const before = line.slice(0, pos + 1);
  const after = line.slice(pos);
  const startMatch = before.match(/(\w+)$/);
  const endMatch = after.match(/^(\w*)/);
  if (!startMatch) return null;
  return startMatch[1] + (endMatch ? endMatch[1].slice(1) : '');
}

// ── Initialize ────────────────────────────────────────────────────────

connection.onInitialize((params) => {
  workspaceRoot = params.workspaceFolders?.[0]?.uri?.replace('file://', '') ?? '';
  scanWorkspace();

  return {
    capabilities: {
      textDocumentSync: 1,
      hoverProvider: true,
      definitionProvider: true,
      completionProvider: {
        triggerCharacters: [':', ' '],
      },
    },
  };
});

// Re-scan when files change
documents.onDidChangeContent(() => {
  scanWorkspace();
});

documents.listen(connection);
connection.listen();
