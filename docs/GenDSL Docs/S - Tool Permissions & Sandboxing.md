# Security: Tool Permissions & Sandboxing

**Doc ID:** gen-dsl/security/tools

## Purpose
Prevent tool-enabled generation from becoming "prompt-to-RCE".

## Norms (recommended)
- Deny tools by default.
- Explicit allowlist per GenModel / method.
- Network egress restrictions for risky tools.
- No arbitrary code execution tools in production.

## See also
- [[P - uses (tools)]]
- [[S - Secrets & Data Boundaries]]
