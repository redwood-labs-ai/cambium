# Note: GAIA Benchmark Evaluation

**Doc ID:** gen-dsl/note/gaia-benchmark

## Purpose
Run Cambium against the GAIA benchmark to measure how much the framework's governance (typed contracts, repair loops, correctors, compound review, grounding) improves accuracy over raw LLM output. The comparison is: **same model, with vs without Cambium**.

## What is GAIA?
GAIA (General AI Assistants) is a benchmark from Meta/HuggingFace that tests real-world multi-step tasks. Tasks require extracting information, using tools, computing answers, and reasoning across sources. Humans solve 92%+ of tasks; GPT-4 at launch scored ~15% on Level 3.

- **Dataset**: `gaia-benchmark/GAIA` on HuggingFace (~165 validation questions, answers public)
- **Scoring**: exact match with normalization (case-insensitive, whitespace, number formatting)
- **Levels**: 1 (simple, 1-3 steps), 2 (medium, 3-7 steps), 3 (hard, 7+ steps)

## Why GAIA highlights Cambium's strengths

| GAIA failure mode | Cambium mitigation |
|---|---|
| Model drops data points from documents | Compound review catches omissions |
| Model computes wrong (arithmetic) | Math corrector + calculator tool |
| Model fabricates information | Grounding + citation enforcement |
| Model outputs wrong structure | Schema validation + repair loop |
| Model doesn't know when to use tools | Agentic mode with tool-use protocol |
| No visibility into what went wrong | Full trace with per-step token tracking |

## Architecture

### GAIA Harness Agent

```ruby
class GaiaAgent < GenModel
  model "omlx:Qwen3.5-27B-4bit"   # or any provider
  system :gaia_solver
  mode :agentic

  returns GaiaAnswer

  uses :web_search, :web_extract, :read_file, :execute_code, :calculator

  corrects :math
  constrain :compound, strategy: :review
  constrain :budget, max_tokens: 15000, max_tool_calls: 20, max_duration: "3m"

  def solve(question)
    generate "answer this question precisely" do
      with context: question
      returns GaiaAnswer
    end
  end
end
```

### GaiaAnswer Schema

```typescript
export const GaiaAnswer = Type.Object(
  {
    reasoning: Type.String(),           // chain of thought (for debugging, not scored)
    answer: Type.String(),              // the final short answer (this is scored)
    tools_used: Type.Array(Type.String()), // which tools were called
    confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false, $id: 'GaiaAnswer' }
)
```

### Evaluation Runner

```
for each task in GAIA validation set:
  1. Load question + optional attached file
  2. Run GaiaAgent#solve(question)
  3. Extract answer from typed output
  4. Score: exact_match(output.answer, ground_truth)
  5. Record: task_id, level, correct, tokens, repairs, tool_calls, trace_path
```

Report: accuracy per level, total accuracy, avg tokens, avg repairs, tool call distribution.

### Baseline Comparison

Run each task twice:
1. **Cambium**: full pipeline (validate, repair, review, correctors, grounding)
2. **Raw**: single LLM call with the same prompt, no governance

Compare accuracy, showing the delta that Cambium's governance provides.

## Tools to Port from Hermes Agent

Hermes Agent (`~/dev/hermes-agent`) has battle-tested implementations. Port the following:

### web_search
- **Hermes**: multi-backend (Exa, Firecrawl, Tavily). Returns search results with snippets.
- **Cambium tool.json**: `{ name: "web_search", inputSchema: { query, limit }, outputSchema: { results: [{ title, url, snippet }] } }`
- **Implementation**: call Exa or Tavily API. Requires `EXA_API_KEY` or `TAVILY_API_KEY`.
- **Permissions**: `{ network: true, network_hosts: ["api.exa.ai"] }`

### web_extract
- **Hermes**: fetches a URL, extracts text content, optionally summarizes with LLM.
- **Cambium tool.json**: `{ name: "web_extract", inputSchema: { url }, outputSchema: { content, title } }`
- **Implementation**: fetch URL, strip HTML, return text. No LLM summarization (keep tools deterministic).
- **Permissions**: `{ network: true }`

### read_file
- **Hermes**: reads files with size guards, binary detection, sensitive path blocking.
- **Cambium tool.json**: `{ name: "read_file", inputSchema: { path }, outputSchema: { content, size_bytes } }`
- **Implementation**: read file, enforce max size, detect binary, block sensitive paths (`.env`, credentials).
- **Permissions**: `{ filesystem: true, filesystem_paths: ["packages/*/examples/fixtures/*"] }`

### execute_code
- **Hermes**: sandboxed Python execution via subprocess.
- **Cambium tool.json**: `{ name: "execute_code", inputSchema: { language, code }, outputSchema: { stdout, stderr, exit_code } }`
- **Implementation**: spawn subprocess with timeout, capture output.
- **Permissions**: `{ exec: true }`
- **Security**: this is the riskiest tool. Must be explicitly allowed in security policy.

### calculator (already built)
- Existing tool, no changes needed.

## Porting Strategy

The Hermes tool implementations are Python functions that take a dict and return a string. Our tools are TypeScript functions that take typed input and return typed output. The port is:

1. Read the Hermes implementation in `~/dev/hermes-agent/tools/`
2. Extract the core logic (API calls, file ops, subprocess spawning)
3. Rewrite in TypeScript with our tool signature: `execute(input: T): U`
4. Create `.tool.json` with the schema
5. Register in `src/tools/index.ts`
6. Add permissions declarations
7. Write tests

## File Plan

| File | Action |
|---|---|
| `packages/cambium/app/tools/web_search.tool.json` | Create |
| `packages/cambium/app/tools/web_extract.tool.json` | Create |
| `packages/cambium/app/tools/read_file.tool.json` | Create |
| `packages/cambium/app/tools/execute_code.tool.json` | Create |
| `src/tools/web_search.ts` | Create — Exa/Tavily API call |
| `src/tools/web_extract.ts` | Create — URL fetch + HTML strip |
| `src/tools/read_file.ts` | Create — guarded file reader |
| `src/tools/execute_code.ts` | Create — sandboxed subprocess |
| `src/tools/index.ts` | Register all new tools |
| `packages/cambium/src/contracts.ts` | Add GaiaAnswer schema |
| `packages/cambium/app/gens/gaia_agent.cmb.rb` | Create — GAIA solver agent |
| `packages/cambium/app/systems/gaia_solver.system.md` | Create |
| `cli/gaia.mjs` | Create — batch evaluation runner + scorer |

## Metrics to Report

- **Accuracy**: % correct per level (1, 2, 3) and overall
- **Cambium vs Raw**: delta showing governance improvement
- **Token efficiency**: avg tokens per correct answer
- **Repair rate**: % of tasks needing repairs (lower = better prompting)
- **Tool usage**: which tools used how often, avg tool calls per task
- **Citation accuracy**: for grounded tasks, % of citations verified

## Prerequisites

- [ ] Hermes Agent cloned to `~/dev/hermes-agent` for reference
- [ ] Exa or Tavily API key for web search
- [ ] HuggingFace `datasets` or manual download of GAIA validation set
- [ ] Python available for `execute_code` tool

## See also
- [[N - Agentic Transactions]]
- [[P - mode]]
- [[P - uses (tools)]]
- [[S - Tool Permissions & Sandboxing]]
