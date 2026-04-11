# Operational Bulletins (runtime control-plane overlay)

## TL;DR
**Operational Bulletins** are a first-class, infrastructure-delivered mechanism to steer agent behavior during incidents (or other operational events) **without relying on the model to fetch, remember, or comply**.

Key properties:
- **Out-of-band fetch:** bulletins are fetched by the runner (not the model) → **0 tokens** to retrieve.
- **Deterministic relevance:** applicability is decided by rules (not model judgment).
- **Enforced constraints:** the runner/tool-router can hard-block tools or redirect flows.
- **Seam delivery:** bulletins can arrive **mid-session** (post-tool/post-step) and still take effect.
- **Non-spammy:** runner only injects relevant bulletins; sessions can **ack/mute** with TTL.

This pattern was motivated by a real incident workflow: composing an incident bulletin via internal API + Redis, then using Claude Code post-tool hooks to divert parallel investigation and route the user to the incident commander.

---

## Problem
In real operational settings (incidents, outages, known-bad dependencies), we need a reliable way to:
- prevent duplicate investigations and wasted tool calls/tokens
- route questions to an incident commander / canonical source of truth
- temporarily restrict certain actions (e.g., comms, DB writes, destructive tools)
- update guidance **during** a running agent session

Relying on the model to **poll** for bulletins or to **remember** to check them is not reliable.
Relying on the model to **comply** with bulletin text is also not reliable.

---

## Design principles
1. **Bulletins are infrastructure, not prompting.** The runner owns bulletin fetch + policy.
2. **Deterministic first.** Relevance and enforcement must be computable without LLM calls.
3. **Seam insertion.** The most reliable time to deliver operational context is *between* tool steps.
4. **Enforcement > advice.** If a bulletin matters, enforce it at the tool router/step controller.
5. **Minimal model exposure.** Only inject what is needed for user-facing explanation.
6. **Auditability.** Trace should record which bulletins were active/applied.

---

## Data model (proposed)
A bulletin should be structured (not a blob), with stable IDs and TTL.

```ts
export type BulletinSeverity = 'info' | 'warn' | 'critical';
export type BulletinStatus = 'active' | 'resolved';

export interface Bulletin {
  id: string;                 // e.g. "INC-2026-04-10-MARKETO"
  title: string;
  severity: BulletinSeverity;
  status: BulletinStatus;

  createdAt: string;          // ISO
  updatedAt?: string;         // ISO
  expiresAt?: string;         // ISO (preferred) OR TTL in store

  // Deterministic scoping (no embeddings required)
  scope: {
    env?: string;             // prod/staging/etc
    org?: string;
    team?: string;
    service?: string;
    project?: string;
    incidentId?: string;
    customerId?: string;
    tags?: string[];          // e.g. ['marketo','email','trade-confirmations']
  };

  bodyMarkdown: string;       // human readable explanation

  // Optional strongly-typed actions for UI/agent behaviors
  actions?: Array<
    | { type: 'link'; label: string; url: string }
    | { type: 'contact'; label: string; value: string }
    | { type: 'route'; label: string; target: string }
  >;

  // Enforced constraints (the runner/tool router reads these)
  constraints?: {
    disableTools?: string[];  // tool IDs or namespaces
    requireEscalation?: {
      onTags?: string[];      // if session/task matches tags
      to: string;             // e.g. 'incident_commander'
    };
    budgetOverride?: {
      maxToolCalls?: number;
      maxTurns?: number;
    };
  };

  // Optional provenance
  source?: {
    actor?: string;           // 'steve', 'ic-bot', etc
    system?: string;          // 'retool', 'pagerduty', etc
    signature?: string;       // optional MAC/signature
  };
}
```

Notes:
- Keep the schema small and enforceable; resist adding “smart” fields that require LLM interpretation.
- TTL/expiry is essential to avoid stale guidance.

---

## Lifecycle
- **Publish**: create bulletin with TTL/expiry.
- **Update**: revise body/constraints/severity (same `id`, bump `updatedAt`).
- **Resolve**: status → `resolved` (or expire naturally).

Recommended behavior:
- If severity increases (info→warn→critical), delivery should break through per-session mutes.
- Updates should carry a revision marker (e.g. `updatedAt` or `version`) so the runner can detect changes.

---

## Delivery model (how it reaches the agent)
### Fetch (0 tokens)
The runner keeps a local cache of active bulletins:
- storage backend: Redis (fast TTL), Postgres (audit), file (dev)
- fetch trigger: timer + post-tool hook
- cache TTL: short (e.g. 5–30s) or event-driven (pub/sub)

### Seam insertion (mid-session)
Bulletins should be evaluated/delivered at reliable seams:
- **post-tool** (preferred): after every tool call (or every N), check for new/relevant bulletins before the next model turn
- **post-step**: after each IR step completes

The runner may inject a minimal “Operational Bulletin Notice” into the next model context **only when relevant**.

---

## Relevance (deterministic)
The runner decides applicability without an LLM.

Example rules (composable):
- scope match on `env/org/team/service/project`
- tag match between bulletin tags and session/task tags
- optional keyword/regex match on user request text (cheap local)

If not relevant, the model never sees the bulletin and no enforcement is activated.

---

## Mute / Ack (avoid spamming the model)
Because bulletins may be checked frequently, we need a way to avoid repeating the same notice.

Proposed session state:
- `acknowledged[sessionId][bulletinId] = { seenAt, mutedUntil? }`

Rules:
- If bulletin is **acknowledged** and unchanged, do not re-inject for that session.
- If muted, suppress until `mutedUntil`.
- If severity increases or bulletin revision changes materially, re-notify even if muted.

This can be implemented either:
- purely by runner state (best), or
- optionally with a small tool the model can call (e.g. `bulletins.ack`, `bulletins.mute`) **after** it has been shown.

---

## Enforcement (the actual safety / reliability)
If a bulletin includes `constraints`, enforcement happens in the runner and tool router:

Examples:
- `disableTools`: block tool calls (return structured error explaining it’s blocked by bulletin)
- `requireEscalation`: redirect flow to an escalation step or route target
- `budgetOverride`: cap tool calls/turns to avoid burning tokens/tools during incidents

The model may still be informed so it can explain the situation to the user, but **behavior does not depend on model compliance**.

---

## Trace / observability
Traces should record:
- bulletins active at each turn
- bulletins applied (relevance matched)
- enforcement events (tool blocked, escalation forced)
- acknowledgements/mutes

This is critical for debugging: “Why did the agent refuse tool X?” should be answerable.

---

## Example: incident bulletin redirect
Scenario: user asks about missing trade confirmation emails.
- Runner detects an active bulletin tagged `marketo` + `trade-confirmations`.
- Runner blocks deep investigation tools and forces escalation:
  - returns: “Known Marketo outage; contact incident commander; do not duplicate investigation/comms.”
- Model receives minimal notice and can reply coherently without spending tokens exploring dead ends.

---

## Non-goals
- “Smart” relevance that depends on an LLM deciding whether a bulletin is applicable.
- Letting bulletins override global safety policy. Bulletins are a *control-plane overlay*, not an escape hatch.

---

## Open questions
- What is the initial minimal backend (Redis vs file) for Cambium’s first implementation?
- How should bulletins map onto IR concepts (task tags, service scopes, etc.)?
- Should enforcement be primarily tool-router level, or also IR-step-level (recommended: both, with tool-router as the hard stop)?
