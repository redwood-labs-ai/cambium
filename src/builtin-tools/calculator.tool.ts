/**
 * Framework-builtin tool (RED-221). Paired with calculator.tool.json;
 * auto-discovered by the registry at runner startup, same as any
 * app-supplied plugin tool.
 */

export function execute(input: { operation: string; operands: number[] }): { value: number } {
  const { operation, operands } = input;
  if (!operands.length) throw new Error('calculator: empty operands');

  switch (operation) {
    case 'avg':
      return { value: Math.round((operands.reduce((a, b) => a + b, 0) / operands.length) * 1000) / 1000 };
    case 'sum':
      return { value: operands.reduce((a, b) => a + b, 0) };
    case 'min':
      return { value: Math.min(...operands) };
    case 'max':
      return { value: Math.max(...operands) };
    default:
      throw new Error(`calculator: unknown operation "${operation}"`);
  }
}
