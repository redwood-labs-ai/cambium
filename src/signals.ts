export type SignalDef = {
  name: string;
  type: string;  // "number", "string", "date", "array", "any"
  unit?: string;
  path?: string; // dot-separated JSON path, e.g. "metrics.latency_ms_samples"
};

export type SignalState = Record<string, any>;

/**
 * Extract signal values from validated output data.
 *
 * If a signal has an explicit `path`, resolve it directly.
 * Otherwise, auto-discover by matching field names against the signal name.
 */
export function extractSignals(data: any, signalDefs: SignalDef[]): SignalState {
  const state: SignalState = {};

  for (const sig of signalDefs) {
    let value: any;

    if (sig.path) {
      value = resolvePath(data, sig.path);
    } else {
      value = autoDiscover(data, sig.name);
    }

    if (value !== undefined) {
      state[sig.name] = value;
    }
  }

  return state;
}

function resolvePath(obj: any, path: string): any {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Auto-discover a signal value by searching for fields whose name
 * contains the signal name (or vice versa).
 */
function autoDiscover(obj: any, signalName: string, depth = 0): any {
  if (obj == null || typeof obj !== 'object' || depth > 5) return undefined;
  if (Array.isArray(obj)) return undefined;

  // Direct match
  if (signalName in obj) return obj[signalName];

  // Check if any key contains the signal name or vice versa
  for (const key of Object.keys(obj)) {
    if (key.includes(signalName) || signalName.includes(key)) {
      return obj[key];
    }
  }

  // Recurse into nested objects
  for (const key of Object.keys(obj)) {
    if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      const found = autoDiscover(obj[key], signalName, depth + 1);
      if (found !== undefined) return found;
    }
  }

  return undefined;
}
