/**
 * Auto-generate a human-readable schema description from a TypeBox/JSON Schema object.
 * Injected into the system prompt so the model knows the exact shape on the first try.
 */
export function describeSchema(schema: any, indent = 0): string {
  const lines: string[] = [];
  const prefix = '  '.repeat(indent);

  if (schema.type === 'object' && schema.properties) {
    const required = new Set<string>(schema.required ?? []);

    for (const [key, prop] of Object.entries<any>(schema.properties)) {
      const req = required.has(key) ? 'required' : 'optional';
      const desc = describeField(key, prop, req, indent);
      lines.push(...desc);
    }
  }

  return lines.join('\n');
}

function describeField(key: string, prop: any, req: string, indent: number): string[] {
  const prefix = '  '.repeat(indent);
  const lines: string[] = [];

  if (prop.type === 'string') {
    lines.push(`${prefix}- ${key} (string, ${req})`);
  } else if (prop.type === 'number') {
    lines.push(`${prefix}- ${key} (number, ${req})`);
  } else if (prop.type === 'boolean') {
    lines.push(`${prefix}- ${key} (boolean, ${req})`);
  } else if (prop.type === 'array') {
    const itemDesc = describeArrayItem(prop.items);
    lines.push(`${prefix}- ${key} (array, ${req}): ${itemDesc}`);

    // If items are objects, show their nested structure
    if (prop.items?.type === 'object' && prop.items.properties) {
      lines.push(`${prefix}  each item:`);
      const nested = describeSchema(prop.items, indent + 2);
      if (nested) lines.push(nested);
    }
  } else if (prop.type === 'object' && prop.properties) {
    lines.push(`${prefix}- ${key} (object, ${req}):`);
    const nested = describeSchema(prop, indent + 1);
    if (nested) lines.push(nested);
  } else if (Array.isArray(prop.type)) {
    // Union types like ["number", "null"]
    const types = prop.type.filter((t: string) => t !== 'null');
    const nullable = prop.type.includes('null') ? ', nullable' : '';
    lines.push(`${prefix}- ${key} (${types.join('|')}${nullable}, ${req})`);
  } else if (prop.anyOf || prop.oneOf) {
    // Union via anyOf/oneOf (TypeBox Optional generates this)
    const variants = (prop.anyOf ?? prop.oneOf) as any[];
    const types = variants
      .map((v: any) => {
        if (v.type === 'null') return null;
        if (v.type) return v.type;
        if (v.const !== undefined) return JSON.stringify(v.const);
        return '?';
      })
      .filter(Boolean);
    lines.push(`${prefix}- ${key} (${types.join('|')}, ${req})`);
  } else {
    lines.push(`${prefix}- ${key} (${prop.type ?? 'unknown'}, ${req})`);
  }

  return lines;
}

function describeArrayItem(items: any): string {
  if (!items) return 'any[]';
  if (items.type === 'string') return 'each item is a string';
  if (items.type === 'number') return 'each item is a number';
  if (items.type === 'object') return 'each item is an object (see below)';
  return `each item is ${items.type ?? 'unknown'}`;
}

/**
 * Generate the full schema block for injection into a system prompt.
 */
export function schemaPromptBlock(schema: any): string {
  const desc = describeSchema(schema);
  return [
    'SCHEMA (output must match this structure exactly):',
    desc,
    `No extra keys. additionalProperties is false at every level.`,
  ].join('\n');
}
