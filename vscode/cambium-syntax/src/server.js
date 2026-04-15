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
let correctorFiles = {}; // name → path
let schemaExports = {};  // name → { path, line }
let signalDefs = {};     // name → line (per-file extract declarations)

function scanWorkspace() {
  if (!workspaceRoot) return;

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

  // Scan correctors
  const correctorsDir = path.join(workspaceRoot, 'src/correctors');
  if (fs.existsSync(correctorsDir)) {
    for (const f of fs.readdirSync(correctorsDir)) {
      if (f.endsWith('.test.ts') || f === 'index.ts' || f === 'types.ts') continue;
      if (!f.endsWith('.ts')) continue;
      const name = f.replace('.ts', '');
      correctorFiles[name] = path.join(correctorsDir, f);
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
}

// ── Primitive documentation ───────────────────────────────────────────

const PRIMITIVE_DOCS = {
  model: {
    detail: 'Declares the LLM provider and model.',
    doc: 'Format: `provider:model_name` (e.g., `"omlx:Qwen3.5-27B-4bit"`)\n\nIf no provider prefix, uses `default_provider` from config.',
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
    doc: '`mode :agentic` enables multi-turn tool-use loop.\nThe model calls tools during generation, receives results, iterates.\n\n```ruby\nmode :agentic\n```',
  },
  repair: {
    detail: 'Configures the repair policy for validation failures.',
    doc: 'Controls how the runner retries when output fails validation.\n\n```ruby\nrepair max_attempts: 3, stop_on_no_improvement: true\n```\n\n`max_attempts` — max repair iterations (default: from `policies.max_repair_attempts`)\n`stop_on_no_improvement` — halt if error count doesn\'t decrease',
  },
  security: {
    detail: 'Configures tool security permissions.',
    doc: 'Controls filesystem and network access for tool execution.\n\n```ruby\nsecurity allow_network: true, allow_filesystem: true\n```',
  },
  with: {
    detail: 'Passes context into a generate block.',
    doc: 'Keyword arguments become context fields available during generation.\n\n```ruby\nwith context: document\n```',
  },
  tool: {
    detail: 'Queues a tool call inside a trigger block.',
    doc: 'Executes a registered tool when the trigger fires.\n\n```ruby\ntool :calculator, operation: "avg", target: "metrics.avg_latency_ms"\n```',
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

    // Corrector reference
    if (correctorFiles[word]) {
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: `**:${word}** — Corrector\n\n*${correctorFiles[word]}*`,
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
    return { uri: 'file://' + correctorFiles[word], range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } };
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

  // After "uses :" → suggest tools
  if (/uses\s+.*:/.test(line)) {
    return Object.keys(toolDefs).map(name => ({
      label: name,
      kind: CompletionItemKind.Function,
      detail: toolDefs[name].description,
    }));
  }

  // After "corrects :" → suggest correctors
  if (/corrects\s+.*:/.test(line)) {
    return Object.keys(correctorFiles).map(name => ({
      label: name,
      kind: CompletionItemKind.Function,
      detail: `Corrector: ${name}`,
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
    return [{ label: 'agentic', kind: CompletionItemKind.EnumMember, detail: 'Multi-turn tool-use loop' }];
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
      { label: 'allow_network:', kind: CompletionItemKind.Property, detail: 'Allow network access for tools' },
      { label: 'allow_filesystem:', kind: CompletionItemKind.Property, detail: 'Allow filesystem access for tools' },
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
