//! Wire protocol between the Cambium Node runner (host) and this agent
//! (guest). JSON payloads, serde-derived, designed to match the shape
//! declared in RED-255. Additions here must stay compatible with the
//! host-side `FirecrackerSubstrate` implementation.
//!
//! The TypeScript host side will accept this shape via `JSON.parse` on
//! the response body; fields use `snake_case` on the wire because
//! that's what serde's default `rename_all = "snake_case"` produces
//! and what reads naturally in TypeScript interfaces.

use serde::{Deserialize, Serialize};

/// Guest languages the agent can dispatch. Matches the `ExecOpts.language`
/// enum on the host-side substrate interface in
/// `packages/cambium-runner/src/exec-substrate/types.ts`. Adding a new
/// variant here requires a paired addition there AND a spawner for it
/// in `spawn.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Language {
    /// Node.js. Script written to `/tmp/script.js`, run via `node`.
    Js,
    /// CPython. Script written to `/tmp/script.py`, run via `python3`.
    Python,
}

/// Structured outcome. One-to-one with the trace-event types RED-249
/// defined (`ExecCompleted` / `ExecTimeout` / `ExecOOM` / `ExecCrashed`);
/// the host translates these strings into the matching `Exec*` trace
/// step. `EgressDenied` is reserved for future substrates that can
/// introspect blocked network/fs ops at the agent layer; v1 of the
/// Firecracker agent doesn't distinguish "fetch failed because no
/// route" from "script crashed" — those surface as `Completed` with
/// non-zero `exit_code`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Guest code ran to completion, any `exit_code`. Non-zero is
    /// still Completed — it means the script crashed, not the substrate.
    Completed,
    /// Wall-clock cap hit. Agent killed the interpreter.
    Timeout,
    /// Interpreter exit code 137 (SIGKILL, typically from kernel OOM-killer).
    Oom,
    /// Reserved for future substrate enhancements that block network/fs
    /// at the agent layer. Unused in v1 Firecracker agent.
    EgressDenied,
    /// Agent-internal failure (spawn error, protocol parse error, etc.).
    /// NOT the same as a guest crash — this is our code failing, not
    /// the user's.
    Crashed,
}

/// Single-call request from host to agent. The agent reads exactly
/// one of these per VM (per-call VM lifecycle per the RED-251 design).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecRequest {
    pub language: Language,
    pub code: String,
    /// Informational only in v1 — CPU fairness is not enforced at the
    /// agent layer. The value is echoed back in trace meta but does
    /// not bind.
    pub cpu: f32,
    /// Informational only in v1 — memory enforcement happens at the
    /// Firecracker VM config level, not the agent's cgroup.
    pub memory_mb: u32,
    /// Wall-clock cap on the interpreter's run. Agent kills the
    /// subprocess if it runs past this.
    pub timeout_seconds: u32,
    /// Total stdout + stderr cap. Excess bytes are dropped with a
    /// truncation marker; the corresponding `truncated_*` flag flips.
    pub max_output_bytes: u64,
}

/// Single-call response from agent back to host. Written after the
/// interpreter exits (or the timeout / OOM kills it). Agent exits
/// after writing this.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecResponse {
    pub status: Status,
    /// Exit code if the interpreter completed. None for non-`Completed`
    /// statuses (Timeout kills before exit, etc.).
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated_stdout: bool,
    pub truncated_stderr: bool,
    pub duration_ms: u64,
    /// Human-readable reason for non-`Completed` statuses. Appended
    /// to the host's stderr output via the existing collapse logic.
    pub reason: Option<String>,
}

impl ExecResponse {
    /// Convenience constructor for a crashed response with no output.
    /// Used when the agent fails before it can run the interpreter
    /// (protocol parse error, file write failure, etc.).
    pub fn crashed(reason: impl Into<String>) -> Self {
        Self {
            status: Status::Crashed,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            truncated_stdout: false,
            truncated_stderr: false,
            duration_ms: 0,
            reason: Some(reason.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_serializes_as_snake_case() {
        assert_eq!(serde_json::to_string(&Language::Js).unwrap(), r#""js""#);
        assert_eq!(
            serde_json::to_string(&Language::Python).unwrap(),
            r#""python""#
        );
    }

    #[test]
    fn language_deserializes_expected_strings() {
        assert_eq!(
            serde_json::from_str::<Language>(r#""js""#).unwrap(),
            Language::Js
        );
        assert_eq!(
            serde_json::from_str::<Language>(r#""python""#).unwrap(),
            Language::Python
        );
    }

    #[test]
    fn language_rejects_unknown_variants() {
        // A request with `language: "ruby"` must fail at parse time,
        // not at spawn — catching it early keeps error messages clear
        // and prevents a runtime mistake from looking like a crash.
        assert!(serde_json::from_str::<Language>(r#""ruby""#).is_err());
    }

    #[test]
    fn status_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&Status::Completed).unwrap(),
            r#""completed""#
        );
        assert_eq!(
            serde_json::to_string(&Status::Timeout).unwrap(),
            r#""timeout""#
        );
        assert_eq!(serde_json::to_string(&Status::Oom).unwrap(), r#""oom""#);
        assert_eq!(
            serde_json::to_string(&Status::EgressDenied).unwrap(),
            r#""egress_denied""#
        );
        assert_eq!(
            serde_json::to_string(&Status::Crashed).unwrap(),
            r#""crashed""#
        );
    }

    #[test]
    fn exec_request_round_trip() {
        let req = ExecRequest {
            language: Language::Js,
            code: "console.log(42);".to_string(),
            cpu: 1.0,
            memory_mb: 256,
            timeout_seconds: 30,
            max_output_bytes: 50_000,
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: ExecRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req, parsed);
    }

    #[test]
    fn exec_response_round_trip() {
        let resp = ExecResponse {
            status: Status::Completed,
            exit_code: Some(0),
            stdout: "42\n".to_string(),
            stderr: String::new(),
            truncated_stdout: false,
            truncated_stderr: false,
            duration_ms: 123,
            reason: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: ExecResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, parsed);
    }

    #[test]
    fn exec_response_crashed_helper() {
        let resp = ExecResponse::crashed("protocol parse failed");
        assert_eq!(resp.status, Status::Crashed);
        assert_eq!(resp.exit_code, None);
        assert_eq!(resp.reason.as_deref(), Some("protocol parse failed"));
        assert!(resp.stdout.is_empty());
        assert!(resp.stderr.is_empty());
    }

    #[test]
    fn exec_request_rejects_missing_required_fields() {
        // A host bug that omits `code` MUST fail at parse time — the
        // agent would otherwise proceed to spawn an empty script.
        let partial = r#"{"language":"js","cpu":1,"memory_mb":64,"timeout_seconds":5,"max_output_bytes":1000}"#;
        assert!(serde_json::from_str::<ExecRequest>(partial).is_err());
    }
}
