/**
 * Cambium IR (Intermediate Representation) — v0
 *
 * This file defines a minimal, runtime-aligned contract for the compiled plan that
 * the runner executes. Keep it intentionally small and forward-compatible.
 */

export type IRVersion = 0;

export type IRMode = 'single' | 'agentic';

export type IRStepType =
  | 'Retrieve'
  | 'Generate'
  | 'ToolCall'
  | 'Validate'
  | 'Repair'
  | 'Correct'
  | 'Return'
  // Runtime/system-only steps (not necessarily emitted by compiler yet)
  | 'SecurityCheck'
  | 'Enrich';

export type IRStepBase = {
  /** Stable step id (used for trace correlation + UI rendering). */
  id: string;
  type: IRStepType;
  /** Optional human label for UI. */
  name?: string;
};

export type IRGenerateStep = IRStepBase & {
  type: 'Generate';
  /** Optional: override system/prompt selection. Runner currently reads from IR root. */
  meta?: Record<string, unknown>;
};

export type IRStep = IRGenerateStep | IRStepBase;

export type IRBudgetConstraints = {
  budget?: {
    max_tokens?: number;
    max_tool_calls?: number;
    max_duration_ms?: number;
  };
  compound?: {
    strategy?: 'review' | 'none';
  };
  consistency?: {
    passes?: number;
  };
};

export type IRPolicies = {
  tools_allowed?: string[];
  correctors?: string[];
  max_repair_attempts?: number;
  constraints?: IRBudgetConstraints;
  grounding?: {
    require_citations?: boolean;
  };
  // Permissions policy is defined elsewhere; runner passes it through.
  [k: string]: any;
};

export type IREnrichmentDef = {
  field: string;
  agent: string;
  [k: string]: any;
};

export type IRSignalDef = { name: string; path: string; [k: string]: any };
export type IRTriggerDef = { when: any; set?: string; tool?: string; [k: string]: any };

export type IRRoot = {
  version: IRVersion;
  /** entry step id (optional for now; runner iterates ir.steps). */
  entry?: string;

  mode?: IRMode;

  /** model id (e.g. "omlx:Qwen...") */
  model: string;

  /** Context that prompts/system templates reference. */
  context: Record<string, any>;

  /** Policies and runtime constraints. */
  policies?: IRPolicies;

  /** Optional enrichments run before main generation. */
  enrichments?: IREnrichmentDef[];

  /** Optional signal/trigger tool dispatch. */
  signals?: IRSignalDef[];
  triggers?: IRTriggerDef[];

  /** Schema id to validate/return. */
  returnSchemaId: string;

  /** Steps executed by runner. Currently only Generate is supported. */
  steps: IRStep[];
};
