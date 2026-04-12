export type IRVersion = 0;
export type IRStepType = 'Retrieve' | 'Generate' | 'ToolCall' | 'Validate' | 'Repair' | 'Correct' | 'Return' | 'SecurityCheck' | 'Enrich';

export type IRStepBase = { id: string; type: IRStepType; name?: string };
export type IRGenerateStep = IRStepBase & { type: 'Generate'; meta?: Record<string, unknown> };
export type IRStep = IRGenerateStep | IRStepBase;

export type IRRoot = {
  version: IRVersion;
  entry?: string;
  mode?: 'single' | 'agentic';
  model: string;
  context: Record<string, any>;
  policies?: any;
  enrichments?: any[];
  signals?: any[];
  triggers?: any[];
  returnSchemaId: string;
  steps: IRStep[];
};
