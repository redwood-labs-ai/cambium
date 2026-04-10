export type ToolCallMessage = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/**
 * Parse inline tool calls from model content for models that don't use
 * the OpenAI tool_calls response format.
 *
 * Supported formats:
 *   Gemma:   <|tool_call>call:tool_name{json_args}<tool_call|>
 *   Generic: <tool_call>{"name":"...","arguments":{...}}</tool_call>
 */
export function parseInlineToolCalls(content: string): ToolCallMessage[] {
  const calls: ToolCallMessage[] = [];
  let id = 0;

  if (!content) return calls;

  // Gemma format: <|tool_call>call:name{args}<tool_call|>
  // Args use <|"|> as quote delimiters: {key:<|"|>value<|"|>}
  for (const m of content.matchAll(
    /<\|tool_call>call:(\w+)\{([\s\S]*?)\}(?:<\/?tool_call\|?>|$)/g
  )) {
    const name = m[1];
    let argsStr = m[2];

    // Normalize Gemma quote delimiters to regular quotes
    argsStr = argsStr.replace(/<\|"\|>/g, '"');
    // Normalize key:value to "key":value for JSON parsing
    argsStr = argsStr.replace(/(\w+):/g, '"$1":');

    try {
      const args = JSON.parse(`{${argsStr}}`);
      calls.push({
        id: `inline_${id++}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
    } catch {
      // Couldn't parse — best-effort simple kv parsing
      try {
        const simple: Record<string, string> = {};
        for (const kv of argsStr.matchAll(/"?(\w+)"?\s*:\s*"([^"]*)"/g)) {
          simple[kv[1]] = kv[2];
        }
        if (Object.keys(simple).length > 0) {
          calls.push({
            id: `inline_${id++}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(simple) },
          });
        }
      } catch {}
    }
  }

  // Generic XML format: <tool_call>{"name":"...","arguments":{...}}</tool_call>
  if (calls.length === 0) {
    for (const m of content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
      try {
        const parsed = JSON.parse(m[1]);
        calls.push({
          id: `inline_${id++}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments ?? {}),
          },
        });
      } catch {}
    }
  }

  return calls;
}
