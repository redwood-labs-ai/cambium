import { join } from 'node:path';
import type { MemoryDecl, MemoryRunContext } from './types.js';

/**
 * RED-215 phase 3: resolve a memory decl to a concrete bucket file path.
 *
 * Shape: `<runsRoot>/memory/<scope>/<key>/<name>.sqlite`
 *
 * Key resolution:
 *   :session scope       → key = the run's session id
 *   :global scope + no keyed_by   → key = '_'
 *   <other> with keyed_by <name>  → key = ctx.keys[<name>], missing = clear error
 *
 * The scope segment comes straight from the IR (validated at compile
 * time against the pool-name regex), so it can't contain traversal
 * bytes. Key values from --memory-key go through parseMemoryKeys,
 * which rejects anything outside [a-zA-Z0-9_\\-].
 */
export function resolveBucketPath(decl: MemoryDecl, ctx: MemoryRunContext): string {
  const scopeSeg = decl.scope;
  let keySeg: string;

  if (decl.scope === 'session') {
    keySeg = ctx.sessionId;
  } else if (decl.scope === 'global' && !decl.keyed_by) {
    keySeg = '_';
  } else {
    const keyName = decl.keyed_by;
    if (!keyName) {
      throw new Error(
        `memory '${decl.name}' scope: :${decl.scope} has no keyed_by — ` +
          'named-pool and non-session global memories must declare keyed_by on the pool or decl.',
      );
    }
    const keyValue = ctx.keys[keyName];
    if (!keyValue) {
      throw new Error(
        `memory '${decl.name}' scope: :${decl.scope} needs --memory-key ${keyName}=<value>. ` +
          `No value was provided at run time.`,
      );
    }
    keySeg = keyValue;
  }

  return join(ctx.runsRoot, 'memory', scopeSeg, keySeg, `${decl.name}.sqlite`);
}
