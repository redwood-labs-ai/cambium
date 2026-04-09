import { execute as calculatorExecute } from './calculator.js';

export const builtinTools: Record<string, (input: any) => any> = {
  calculator: calculatorExecute,
};
