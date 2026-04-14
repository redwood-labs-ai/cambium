#!/usr/bin/env npx tsx
/**
 * GAIA mini-eval runner (RED-145)
 *
 * Runs gaia_solver.cmb.rb against a set of question files and scores results.
 *
 * Usage:
 *   npx tsx scripts/gaia-eval.ts \
 *     --questions packages/cambium/examples/gaia-questions/ \
 *     --expected packages/cambium/examples/gaia-questions/expected.jsonl \
 *     --output eval-results.jsonl
 *
 * Each question file contains the question text.
 * expected.jsonl is line-delimited JSON: {"file": "q1.txt", "answer": "42"}
 * Output is JSONL with per-question results + a summary line at the end.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';

type ExpectedEntry = { file: string; answer: string; task_id?: string };

type EvalResult = {
  task_id: string;
  file: string;
  question: string;
  model_answer: string;
  expected_answer: string;
  correct: boolean;
  tokens: { prompt: number; completion: number; total: number };
  tool_calls: number;
  duration_s: number;
  repairs: number;
  trace_path: string;
  ok: boolean;
  error?: string;
};

type EvalSummary = {
  type: 'summary';
  total: number;
  correct: number;
  accuracy: number;
  avg_tokens: number;
  avg_tool_calls: number;
  avg_duration_s: number;
  results: EvalResult[];
};

// ── Answer normalization ──────────────────────────────────────────────
function normalizeAnswer(s: string): string {
  return s
    .trim()
    .toLowerCase()
    // strip punctuation but keep digits and letters
    .replace(/[^\w\s.-]/g, '')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    // strip trailing periods
    .replace(/\.$/, '')
    .trim();
}

// ── Parse args ────────────────────────────────────────────────────────
function parseArgs(): { questionsDir: string; expectedPath: string; outputPath: string; n: number } {
  const argv = process.argv.slice(2);
  let questionsDir = '';
  let expectedPath = '';
  let outputPath = '';
  let n = 0; // 0 = all

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--questions') questionsDir = argv[++i];
    else if (argv[i] === '--expected') expectedPath = argv[++i];
    else if (argv[i] === '--output') outputPath = argv[++i];
    else if (argv[i] === '-n') n = parseInt(argv[++i], 10);
    else throw new Error(`Unknown arg: ${argv[i]}`);
  }

  if (!questionsDir) throw new Error('Missing --questions <dir>');
  if (!expectedPath) throw new Error('Missing --expected <file>');
  if (!outputPath) throw new Error('Missing --output <file>');

  return { questionsDir, expectedPath, outputPath, n };
}

// ── Read trace and extract metrics ────────────────────────────────────
function extractTraceMetrics(tracePath: string): {
  tokens: { prompt: number; completion: number; total: number };
  tool_calls: number;
  repairs: number;
  ok: boolean;
} {
  const trace = JSON.parse(readFileSync(tracePath, 'utf8'));
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let toolCalls = 0;
  let repairs = 0;
  let ok = false;

  for (const step of trace.steps ?? []) {
    // Accumulate usage from Generate/Repair/AgenticTurn steps
    const usage = step.meta?.usage;
    if (usage) {
      promptTokens += usage.prompt_tokens ?? 0;
      completionTokens += usage.completion_tokens ?? 0;
      totalTokens += usage.total_tokens ?? 0;
    }

    // Count agentic tool calls
    if (step.type === 'AgenticTurn') {
      toolCalls += step.meta?.tool_calls?.length ?? 0;
    }

    // Count repair attempts
    if (step.type === 'Repair') {
      repairs++;
    }

    // Check for final result
    if (step.type === 'Return') {
      ok = step.ok ?? false;
    }
  }

  // Fallback: check trace.final
  if (!ok && trace.final?.ok) {
    ok = true;
  }

  return {
    tokens: { prompt: promptTokens, completion: completionTokens, total: totalTokens },
    tool_calls: toolCalls,
    repairs,
    ok,
  };
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const { questionsDir, expectedPath, outputPath, n } = parseArgs();

  // Load expected answers
  const expectedLines = readFileSync(expectedPath, 'utf8')
    .split('\n')
    .filter(l => l.trim());
  const expectedMap = new Map<string, ExpectedEntry>();
  for (const line of expectedLines) {
    const entry: ExpectedEntry = JSON.parse(line);
    expectedMap.set(entry.file, entry);
  }

  // Get question files
  let files = readdirSync(questionsDir)
    .filter(f => f.endsWith('.txt') || f.endsWith('.md') || f.endsWith('.json'))
    .sort();

  if (n > 0) files = files.slice(0, n);

  console.error(`Running eval on ${files.length} questions...`);

  const results: EvalResult[] = [];

  for (const file of files) {
    const filePath = join(questionsDir, file);
    const expected = expectedMap.get(file);
    if (!expected) {
      console.error(`  SKIP ${file} — no expected answer found`);
      continue;
    }

    const questionText = readFileSync(filePath, 'utf8').trim();
    const taskId = expected.task_id ?? basename(file, /\.\w+$/.exec(file)?.[0] ?? '.txt');

    console.error(`  [${results.length + 1}/${files.length}] ${file}...`);
    const startTime = Date.now();

    let modelAnswer = '';
    let tracePath = '';
    let runOk = false;
    let error: string | undefined;
    let tokens = { prompt: 0, completion: 0, total: 0 };
    let toolCalls = 0;
    let repairs = 0;

    try {
      // Step 1: compile IR
      const compileCmd = [
        'ruby', './ruby/cambium/compile.rb',
        'packages/cambium/app/gens/gaia_solver.cmb.rb',
        '--method', 'solve',
        '--arg', filePath,
      ];
      const irJson = execSync(compileCmd.join(' '), {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
        timeout: 30_000,
      });

      // Step 2: run IR
      const runCmd = 'node --import tsx ./src/runner.ts --ir -';
      try {
        execSync(runCmd, {
          input: irJson,
          encoding: 'utf8',
          maxBuffer: 50 * 1024 * 1024,
          timeout: 600_000, // 10 min max per question
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (runErr: any) {
        // Runner may exit non-zero on budget exceeded or validation failure
        // — still try to read the output
        if (runErr.stderr) {
          const match = runErr.stderr.match(/Trace: (runs\/run_[\w/]+)/);
          if (match) tracePath = match[1];
        }
        if (!tracePath) throw runErr;
      }

      // Step 3: find the latest run directory
      if (!tracePath) {
        const runsDir = './runs';
        if (existsSync(runsDir)) {
          const runDirs = readdirSync(runsDir)
            .filter(d => d.startsWith('run_'))
            .sort()
            .reverse();
          if (runDirs.length > 0) {
            tracePath = join(runsDir, runDirs[0]);
          }
        }
      }

      // Step 4: read output + trace
      if (tracePath) {
        const outputPath2 = join(tracePath, 'output.json');
        if (existsSync(outputPath2)) {
          const output = JSON.parse(readFileSync(outputPath2, 'utf8'));
          if (output && typeof output === 'object') {
            modelAnswer = String(output.answer ?? '');
          }
        }

        const traceJsonPath = join(tracePath, 'trace.json');
        if (existsSync(traceJsonPath)) {
          const metrics = extractTraceMetrics(traceJsonPath);
          tokens = metrics.tokens;
          toolCalls = metrics.tool_calls;
          repairs = metrics.repairs;
          runOk = metrics.ok;
        }
      }
    } catch (e: any) {
      error = e.message?.slice(0, 500);
      console.error(`    ERROR: ${error}`);
    }

    const durationS = (Date.now() - startTime) / 1000;
    const correct = normalizeAnswer(modelAnswer) === normalizeAnswer(expected.answer);

    results.push({
      task_id: taskId,
      file,
      question: questionText.slice(0, 200),
      model_answer: modelAnswer,
      expected_answer: expected.answer,
      correct,
      tokens,
      tool_calls: toolCalls,
      duration_s: Math.round(durationS * 10) / 10,
      repairs,
      trace_path: tracePath,
      ok: runOk,
      error,
    });

    console.error(`    answer="${modelAnswer}" expected="${expected.answer}" correct=${correct} (${durationS.toFixed(1)}s)`);

    // Write incremental results
    const lines = results.map(r => JSON.stringify(r));
    writeFileSync(outputPath, lines.join('\n') + '\n');
  }

  // Summary
  const correct = results.filter(r => r.correct).length;
  const total = results.length;
  const summary: EvalSummary = {
    type: 'summary',
    total,
    correct,
    accuracy: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
    avg_tokens: total > 0 ? Math.round(results.reduce((s, r) => s + r.tokens.total, 0) / total) : 0,
    avg_tool_calls: total > 0 ? Math.round(results.reduce((s, r) => s + r.tool_calls, 0) / total * 10) / 10 : 0,
    avg_duration_s: total > 0 ? Math.round(results.reduce((s, r) => s + r.duration_s, 0) / total * 10) / 10 : 0,
    results,
  };

  // Append summary
  const allLines = [...results.map(r => JSON.stringify(r)), JSON.stringify(summary)];
  writeFileSync(outputPath, allLines.join('\n') + '\n');

  console.error(`\nDone: ${correct}/${total} correct (${summary.accuracy}%)`);
  console.error(`Avg tokens: ${summary.avg_tokens}, avg tool calls: ${summary.avg_tool_calls}, avg duration: ${summary.avg_duration_s}s`);
  console.error(`Results written to ${outputPath}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
