/**
 * #273 — "no output" is not "wrong output".
 *
 * Characterization: an agentic run whose model answers the final turn in
 * prose must re-ask INSIDE the conversation (where the tool transcripts
 * live) and ship only grounded values; a run that never produces JSON must
 * fail honestly with ZERO structural Repair steps. Before #273 both cases
 * routed to context-free structural repair, and the model invented what the
 * schema asked for — 3 of 88 real agentic runs shipped `ok: true` with
 * fabricated tickers (AAPL → NVDA). These tests are the tripwire that the
 * fabrication route stays dead.
 *
 * The single-mode cases pin the runner-level re-ask (validate loop); the
 * agentic ones pin the in-loop re-ask (handleAgenticGenerate) and the
 * role-alternation merge into the forceFinal turn.
 */
import { describe, expect, it } from "vitest";
import type { CambiumProvider } from "./providers/types.js";
import { runGen } from "./runner.js";
import { NO_JSON_REASK_DIRECTIVE } from "./step-handlers.js";

const SOURCE_DOC =
	"ACME CORP FY2025 FILING\n\nACME reported total revenue of $13,769 million " +
	"for fiscal year 2025, up 12% year over year. " +
	"Section filler: the vendor reports quarterly figures net of returns. ".repeat(
		30,
	) +
	"Closing note: audited figures only.";

function baseIR(mode: "single" | "agentic"): any {
	return {
		version: "0.2",
		entry: { class: "Trader", method: "analyze", source: "trader.cmb.rb" },
		model: { id: "fakeprov:m", temperature: 0.1, max_tokens: 512 },
		system: "You research vendor financials.",
		mode,
		policies: {
			tools_allowed: mode === "agentic" ? ["calculator"] : [],
			// Cap the tool budget so a runaway loop can't burn hundreds of turns;
			// one tool call is all these scenarios need.
			budget: mode === "agentic" ? { max_tool_calls: 2 } : {},
			correctors: [],
			constraints: {},
			grounding: null,
			security: {},
		},
		returnSchema: {
			$id: "Extract",
			type: "object",
			properties: { summary: { type: "string" } },
			required: ["summary"],
			additionalProperties: false,
		},
		context: { document: SOURCE_DOC },
		enrichments: [],
		signals: [],
		triggers: [],
		steps: [
			{
				id: "gen_1",
				type: "Generate",
				prompt:
					"Read the document and report ACME FY2025 total revenue in the summary.",
				with: { context: "document" },
				returns: "Extract",
			},
		],
	};
}

const toolCall = {
	id: "c1",
	type: "function" as const,
	function: {
		name: "calculator",
		arguments: '{"operation":"sum","operands":[13769]}',
	},
};

function usage() {
	return { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 };
}

describe("#273 — no-JSON re-ask, never structural fabrication", () => {
	it("agentic: prose final answer → grounded in-conversation re-ask → real values ship, no Repair", async () => {
		const turns: any[] = [];
		let call = 0;
		const provider: CambiumProvider = {
			name: "fakeprov",
			supportsDocuments: false,
			async generateText() {
				throw new Error("not used");
			},
			async decide() {
				throw new Error("not used");
			},
			async generateWithTools(opts: any) {
				turns.push(opts);
				call += 1;
				if (call === 1) {
					return {
						message: { content: null, tool_calls: [toolCall] },
						usage: usage(),
					};
				}
				if (call === 2) {
					// The model "finishes" — in prose. The old route: structural repair
					// invents `{summary: "…"}` from the schema alone.
					return {
						message: {
							content: "ACME made about 13.7 billion last year I think.",
							tool_calls: undefined,
						},
						usage: usage(),
					};
				}
				// Re-ask turn: same conversation, directive as the trailing user turn.
				return {
					message: {
						content:
							'{"summary": "ACME FY2025 total revenue: $13,769 million"}',
						tool_calls: undefined,
					},
					usage: usage(),
				};
			},
		};

		const result = await runGen({
			ir: baseIR("agentic"),
			schemas: {},
			persistRun: false,
			_testProviders: new Map([["fakeprov", provider]]),
		} as any);

		expect(result.ok).toBe(true);
		expect(result.output.summary).toContain("$13,769");

		// Re-ask happened IN the loop, and it was grounded: the re-ask call's
		// message history still carries the tool transcript.
		const reasks = result.trace.steps.filter(
			(s: any) => s.type === "ReaskForJson",
		);
		expect(reasks).toHaveLength(1);
		expect(reasks[0].ok).toBe(true);
		expect(reasks[0].meta).toMatchObject({ reason: "no_json", turn: 2 });

		expect(turns).toHaveLength(3);
		const lastUser = turns[2].messages[turns[2].messages.length - 1];
		expect(lastUser.role).toBe("user");
		expect(lastUser.content).toBe(NO_JSON_REASK_DIRECTIVE);
		expect(turns[2].messages.some((m: any) => m.role === "tool")).toBe(true);

		// The fabrication route stayed dead: no structural Repair, ever.
		expect(
			result.trace.steps.filter((s: any) => s.type === "Repair"),
		).toHaveLength(0);
	});

	it("agentic: never any JSON → honest validation fail, zero Repair", async () => {
		const turns: any[] = [];
		let call = 0;
		const provider: CambiumProvider = {
			name: "fakeprov",
			supportsDocuments: false,
			async generateText() {
				throw new Error("not used");
			},
			async decide() {
				throw new Error("not used");
			},
			async generateWithTools(opts: any) {
				turns.push(opts);
				call += 1;
				if (call === 1) {
					return {
						message: { content: null, tool_calls: [toolCall] },
						usage: usage(),
					};
				}
				// Prose forever — pre-#273 this is where `{summary: "<invented>"}`
				// came back `ok: true`.
				return {
					message: {
						content: "ACME did fine, roughly 14 billion.",
						tool_calls: undefined,
					},
					usage: usage(),
				};
			},
		};

		const result = await runGen({
			ir: baseIR("agentic"),
			schemas: {},
			persistRun: false,
			_testProviders: new Map([["fakeprov", provider]]),
		} as any);

		expect(result.ok).toBe(false);
		expect(result.failureKind).toBe("validation");

		const types = result.trace.steps.map((s: any) => s.type);
		expect(types).toContain("ReaskForJson");
		expect(types.filter((t: string) => t === "Repair")).toHaveLength(0);
		expect(types.filter((t: string) => t === "RepairStopped")).toHaveLength(0);

		// The terminal ReaskForJson row names WHY: the in-loop re-ask already
		// spent itself and the re-asked answer was still prose.
		const terminal = result.trace.steps
			.filter((s: any) => s.type === "ReaskForJson")
			.at(-1);
		expect(terminal).toMatchObject({
			ok: false,
			meta: { reason: "no_json", outcome: "reask_spent_agentic" },
		});

		// The re-ask was a real in-conversation turn: the re-asked (final) call's
		// history ends with the directive as a plain user turn, the tool
		// transcript is still present, and no second ask was stacked on top of it.
		const lastMsgs = turns.at(-1).messages;
		expect(lastMsgs.at(-1).role).toBe("user");
		expect(lastMsgs.at(-1).content).toBe(NO_JSON_REASK_DIRECTIVE);
		expect(
			lastMsgs.filter((m: any) => m.role === "user" && !m.tool_call_id),
		).toHaveLength(2); // task + the one re-ask
		expect(lastMsgs.some((m: any) => m.role === "tool")).toBe(true);
	});

	it("single mode: prose → runner-level re-ask on the warm prefix → grounded output, no Repair", async () => {
		const prompts: string[] = [];
		let call = 0;
		const provider: CambiumProvider = {
			name: "fakeprov",
			supportsDocuments: false,
			async generateText(opts: any) {
				prompts.push(`${opts.system}\n---\n${opts.prompt}`);
				call += 1;
				if (call === 1)
					return {
						text: "ACME earned around 14 billion, give or take.",
						usage: usage(),
					};
				return {
					text: '{"summary": "ACME FY2025 total revenue: $13,769 million"}',
					usage: usage(),
				};
			},
			async generateWithTools() {
				throw new Error("not used");
			},
			async decide() {
				throw new Error("not used");
			},
		};

		const result = await runGen({
			ir: baseIR("single"),
			schemas: {},
			persistRun: false,
			_testProviders: new Map([["fakeprov", provider]]),
		} as any);

		expect(result.ok).toBe(true);
		expect(result.output.summary).toContain("$13,769");

		const types = result.trace.steps.map((s: any) => s.type);
		expect(types).toContain("ReaskForJson");
		expect(types.filter((t: string) => t === "Repair")).toHaveLength(0);

		// Two generate calls, one re-ask row; the directive only rides the
		// second call, appended AFTER the task + document (uncached tail).
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).not.toContain(NO_JSON_REASK_DIRECTIVE);
		expect(prompts[1].endsWith(NO_JSON_REASK_DIRECTIVE)).toBe(true);
		expect(prompts[1]).toContain("$13,769 million"); // document still in front of the model

		const reask = result.trace.steps.find(
			(s: any) => s.type === "ReaskForJson",
		);
		expect(reask.ok).toBe(true);
	});

	it("agentic: tool budget spent, then prose → re-ask still fires on a turn of its own", async () => {
		// The shape #273 was filed for: the model works through its whole tool
		// budget one call per turn, then writes up what it found — in prose. The
		// forced-final turn is also the last turn, so a re-ask guarded on
		// `turn < maxToolCalls` could never fire here and the run just died
		// (trace claiming a re-ask it never spent). The re-ask buys its own turn.
		const turns: any[] = [];
		let call = 0;
		const provider: CambiumProvider = {
			name: "fakeprov",
			supportsDocuments: false,
			async generateText() {
				throw new Error("not used");
			},
			async decide() {
				throw new Error("not used");
			},
			async generateWithTools(opts: any) {
				turns.push(opts);
				call += 1;
				// One tool call per turn until max_tool_calls (2) is spent.
				if (call <= 2) {
					return {
						message: {
							content: null,
							tool_calls: [{ ...toolCall, id: `c${call}` }],
						},
						usage: usage(),
					};
				}
				// Forced-final turn (tools withheld): the model answers in prose.
				if (call === 3) {
					return {
						message: {
							content: "ACME made about 13.7 billion last year I think.",
							tool_calls: undefined,
						},
						usage: usage(),
					};
				}
				// The turn the re-ask bought.
				return {
					message: {
						content:
							'{"summary": "ACME FY2025 total revenue: $13,769 million"}',
						tool_calls: undefined,
					},
					usage: usage(),
				};
			},
		};

		const result = await runGen({
			ir: baseIR("agentic"),
			schemas: {},
			persistRun: false,
			_testProviders: new Map([["fakeprov", provider]]),
		} as any);

		expect(result.ok).toBe(true);
		expect(result.output.summary).toContain("$13,769");

		const reasks = result.trace.steps.filter(
			(s: any) => s.type === "ReaskForJson",
		);
		expect(reasks).toHaveLength(1);
		expect(reasks[0].meta).toMatchObject({ reason: "no_json", turn: 3 });

		// Four model calls: 2 tool turns + the prose turn + the bought turn. The
		// re-ask buys a TURN, never extra tool calls — the budget still capped
		// dispatch at 2, and every turn from the third on was tools-withheld.
		expect(turns).toHaveLength(4);
		expect(turns[2].tools).toHaveLength(0);
		expect(turns[3].tools).toHaveLength(0);

		// The force-final text merged into the directive turn instead of stacking
		// a second user turn, and the tool transcript is still in front of the
		// model — that is what makes the re-asked answer grounded.
		const lastMsgs = turns[3].messages;
		expect(lastMsgs.at(-1).role).toBe("user");
		expect(lastMsgs.at(-1).content).toBe(
			`${NO_JSON_REASK_DIRECTIVE}\n\nYou have gathered enough information. STOP calling tools. Produce your final JSON output now. Output MUST be JSON only, starting with { and ending with }.`,
		);
		expect(lastMsgs.some((m: any) => m.role === "tool")).toBe(true);

		// Fabrication route stays dead.
		expect(
			result.trace.steps.filter((s: any) => s.type === "Repair"),
		).toHaveLength(0);
	});

	it("single mode: the re-asked candidate re-validates as ValidateAfterReask, not ValidateAfterRepair", async () => {
		// A re-ask is not a repair. Labelling its re-validation
		// `ValidateAfterRepair` named a `Repair` step that is provably absent —
		// the no-data path never calls handleRepair.
		let call = 0;
		const provider: CambiumProvider = {
			name: "fakeprov",
			supportsDocuments: false,
			async generateText() {
				call += 1;
				if (call === 1)
					return { text: "ACME did fine, roughly 14 billion.", usage: usage() };
				return {
					text: '{"summary": "ACME FY2025 total revenue: $13,769 million"}',
					usage: usage(),
				};
			},
			async generateWithTools() {
				throw new Error("not used");
			},
			async decide() {
				throw new Error("not used");
			},
		};

		const result = await runGen({
			ir: baseIR("single"),
			schemas: {},
			persistRun: false,
			_testProviders: new Map([["fakeprov", provider]]),
		} as any);

		expect(result.ok).toBe(true);
		const types = result.trace.steps.map((s: any) => s.type);
		expect(types).toContain("ValidateAfterReask");
		expect(types).not.toContain("ValidateAfterRepair");
		expect(types.filter((t: string) => t === "Repair")).toHaveLength(0);
	});

	it("single mode: a genuine repair still re-validates as ValidateAfterRepair", async () => {
		// The counterpart pin — the repair path keeps its own name, so the two
		// routes stay distinguishable in the trace.
		let call = 0;
		const provider: CambiumProvider = {
			name: "fakeprov",
			supportsDocuments: false,
			async generateText() {
				call += 1;
				// Parseable JSON that fails the schema → a real structural repair.
				if (call === 1) return { text: '{"wrong": 1}', usage: usage() };
				return {
					text: '{"summary": "ACME FY2025 total revenue: $13,769 million"}',
					usage: usage(),
				};
			},
			async generateWithTools() {
				throw new Error("not used");
			},
			async decide() {
				throw new Error("not used");
			},
		};

		const result = await runGen({
			ir: baseIR("single"),
			schemas: {},
			persistRun: false,
			_testProviders: new Map([["fakeprov", provider]]),
		} as any);

		expect(result.ok).toBe(true);
		const types = result.trace.steps.map((s: any) => s.type);
		expect(types).toContain("Repair");
		expect(types).toContain("ValidateAfterRepair");
		expect(types).not.toContain("ValidateAfterReask");
		expect(types).not.toContain("ReaskForJson");
	});

	it("single mode: stop_on_no_improvement does not steal the terminal ReaskForJson row", async () => {
		// Both attempts produce exactly one error ("No data to validate"), so the
		// improvement check used to win the race and file the run as
		// RepairStopped(no_improvement) — naming a repair that never ran.
		const provider: CambiumProvider = {
			name: "fakeprov",
			supportsDocuments: false,
			async generateText() {
				return { text: "ACME did fine, roughly 14 billion.", usage: usage() };
			},
			async generateWithTools() {
				throw new Error("not used");
			},
			async decide() {
				throw new Error("not used");
			},
		};

		const ir = baseIR("single");
		ir.policies.repair = { stop_on_no_improvement: true };

		const result = await runGen({
			ir,
			schemas: {},
			persistRun: false,
			_testProviders: new Map([["fakeprov", provider]]),
		} as any);

		expect(result.ok).toBe(false);
		expect(result.failureKind).toBe("validation");

		const types = result.trace.steps.map((s: any) => s.type);
		expect(types).not.toContain("RepairStopped");
		expect(types.filter((t: string) => t === "Repair")).toHaveLength(0);

		const terminal = result.trace.steps.at(-1);
		expect(terminal).toMatchObject({
			type: "ReaskForJson",
			ok: false,
			meta: { reason: "no_json", outcome: "reask_failed" },
		});
	});
});
