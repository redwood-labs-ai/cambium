export type CorrectorIssue = {
  path: string;
  message: string;
  severity: 'fixed' | 'warning' | 'error';
  original?: any;
  corrected?: any;
};

export type CorrectorResult = {
  corrected: boolean;
  output: any;
  issues: CorrectorIssue[];
  meta?: Record<string, any>;
};

export type CorrectorFn = (data: any, context: { document?: string }) => CorrectorResult;
