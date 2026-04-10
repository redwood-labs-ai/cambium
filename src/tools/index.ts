import { execute as calculatorExecute } from './calculator.js';
import { execute as readFileExecute } from './read_file.js';
import { execute as executeCodeExecute } from './execute_code.js';
import { execute as webSearchExecute } from './web_search.js';
import { execute as webExtractExecute } from './web_extract.js';

export const builtinTools: Record<string, (input: any) => any> = {
  calculator: calculatorExecute,
  read_file: readFileExecute,
  execute_code: executeCodeExecute,
  // Async tools wrapped — the handler caller already awaits
  web_search: webSearchExecute as any,
  web_extract: webExtractExecute as any,
};
