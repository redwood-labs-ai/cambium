/**
 * Cambium Trace (observability) — v0
 *
 * A trace is the auditable record of a run. Keep permissive for now, but typed
 * enough to support budgeting + UI overlays.
 */

export type TraceUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type TraceError = {
  message: string;
  instancePath?: string;
  tool?: string;
  permission?: string;
};

export type TraceStep = {
  type: string;
  id?: string;
  ok?: boolean;
  ms?: number;
  errors?: TraceError[];
  meta?: Record<string, any>;
  output?: any;
};

export type TraceRoot = {
  run_id: string;
  version: number;
  entry?: string;
  model: string;
  steps: TraceStep[];
  started_at: string;
  finished_at?: string;
  final?: any;
};
