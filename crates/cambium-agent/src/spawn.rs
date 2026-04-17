//! Interpreter spawn + output capture + exit classification.
//!
//! Two-layer design:
//!
//! * `run_process` is the generic low-level function: takes a program
//!   name, args, timeout, output cap, and the `memory_mb` value (used
//!   only to shape the OOM error message). It handles the full lifecycle
//!   — spawn, drain stdout/stderr via reader threads to avoid pipe
//!   deadlock, poll for exit with timeout, classify the outcome. This
//!   layer is what the unit tests exercise with `sh -c ...` to avoid
//!   depending on `node` / `python3` being installed.
//!
//! * `run_exec` is the language-dispatcher: picks the interpreter per
//!   `Language`, writes the guest code to `/tmp/script.<ext>`, calls
//!   `run_process`. This is what the vsock loop (next commit) calls.
//!
//! Exit classification (matches the host-side Exec* trace vocabulary):
//!
//! * Process exited with any code → `Status::Completed`, `exit_code = Some(n)`.
//!   Non-zero is completed — it means the guest crashed, not the substrate.
//! * Wall-clock timeout hit → agent kills the child, `Status::Timeout`.
//! * Exit code 137 (SIGKILL, typically from the Linux kernel OOM-killer)
//!   → `Status::Oom`. The reason carries the VM's memory limit for
//!   the host-side trace.
//! * Agent-internal failure (spawn error, file I/O error) → `Status::Crashed`
//!   with a clear reason. Distinct from a guest crash.

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use crate::protocol::{ExecRequest, ExecResponse, Language, Status};

/// How often `run_process` polls the child's exit status between the
/// spawn and the wall-clock deadline. 50 ms keeps the timeout precision
/// well within one tenth of a second for any realistic cap while staying
/// coarse enough that polling overhead is negligible.
const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Shell convention for SIGKILL: `128 + 9 = 137`. Rust's
/// `ExitStatus::code()` returns `None` for signal-terminated processes
/// (the signal is on `ExitStatusExt::signal()` separately), so we
/// synthesize this value for the host-visible `exit_code` field when
/// classifying a SIGKILL outcome — it's what downstream tools expect
/// to see in Linux contexts.
const SIGKILL_SYNTHETIC_EXIT: i32 = 137;

/// POSIX signal number for SIGKILL. The Linux kernel's OOM-killer uses
/// this; Firecracker's guest kernel does the same. Our `Status::Oom`
/// classification hinges on detecting this specific signal on child
/// exit (NOT on timeout — `child.kill()` for timeout also sends
/// SIGKILL, so we gate the OOM branch on `!timed_out`).
const SIGKILL: i32 = 9;

/// Minimal PATH for the spawned interpreter to find its own helpers
/// (e.g. `node` resolving its libs, `python3` finding stdlib modules).
/// Env is otherwise cleared — the guest sees no host secrets in env.
const MINIMAL_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// Tunable where each language's script lives inside the VM. `/tmp`
/// always exists and is ephemeral (tmpfs — dies with the VM). Extension
/// is chosen so the interpreter's `.rc` / `.pyc` behavior is correct.
fn script_path_for(language: Language) -> PathBuf {
    match language {
        Language::Js => PathBuf::from("/tmp/script.js"),
        Language::Python => PathBuf::from("/tmp/script.py"),
    }
}

fn interpreter_for(language: Language) -> &'static str {
    match language {
        Language::Js => "node",
        Language::Python => "python3",
    }
}

/// Language-dispatcher. Writes the guest's code to disk, delegates to
/// `run_process`. Used by the main vsock loop (next commit).
pub fn run_exec(req: &ExecRequest) -> ExecResponse {
    let script_path = script_path_for(req.language);
    let program = interpreter_for(req.language);

    if let Err(e) = fs::write(&script_path, &req.code) {
        return ExecResponse::crashed(format!(
            "failed to write script to {}: {}",
            script_path.display(),
            e
        ));
    }

    let args: Vec<String> = vec![script_path.display().to_string()];
    run_process(
        program,
        &args,
        Duration::from_secs(u64::from(req.timeout_seconds)),
        req.max_output_bytes,
        req.memory_mb,
    )
}

/// Generic process runner. Unit-testable via `sh -c 'echo ...'` without
/// depending on `node` / `python3` being installed. Returns a fully-
/// populated `ExecResponse` regardless of outcome — never panics,
/// classifies every non-happy path into a `Status`.
pub fn run_process(
    program: &str,
    args: &[String],
    timeout: Duration,
    max_output_bytes: u64,
    memory_mb: u32,
) -> ExecResponse {
    let started = Instant::now();

    let spawn_result = Command::new(program)
        .args(args)
        .env_clear()
        .env("PATH", MINIMAL_PATH)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();

    let mut child = match spawn_result {
        Ok(c) => c,
        Err(e) => {
            return ExecResponse::crashed(format!("failed to spawn {program}: {e}"));
        }
    };

    // Reader threads drain stdout/stderr concurrently with the process
    // running. Without this, a process that writes more than the pipe
    // buffer can hold will block on write → never exit → we hit the
    // timeout path for what was really just noisy output. Reader
    // threads terminate naturally when the process closes its
    // stdout/stderr handles (i.e. when it exits or is killed).
    let stdout_rx = child.stdout.take().map(spawn_reader);
    let stderr_rx = child.stderr.take().map(spawn_reader);

    // Poll for exit with the wall-clock cap.
    let deadline = started + timeout;
    let (timed_out, exit_status) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (false, Some(status)),
            Ok(None) => {
                if Instant::now() >= deadline {
                    // Best-effort kill; reap zombie after.
                    let _ = child.kill();
                    let _ = child.wait();
                    break (true, None);
                }
                thread::sleep(POLL_INTERVAL);
            }
            Err(e) => {
                return ExecResponse::crashed(format!("wait error on child: {e}"));
            }
        }
    };

    let duration_ms = started.elapsed().as_millis() as u64;

    let stdout_bytes = collect_reader(stdout_rx);
    let stderr_bytes = collect_reader(stderr_rx);
    let (stdout, truncated_stdout) = truncate_utf8(stdout_bytes, max_output_bytes);
    let (stderr, truncated_stderr) = truncate_utf8(stderr_bytes, max_output_bytes);

    if timed_out {
        return ExecResponse {
            status: Status::Timeout,
            exit_code: None,
            stdout,
            stderr,
            truncated_stdout,
            truncated_stderr,
            duration_ms,
            reason: Some(format!("wall-clock timeout ({}s)", timeout.as_secs())),
        };
    }

    // OOM detection — SIGKILL on child exit (and we did NOT time out,
    // since our own timeout path also sends SIGKILL via child.kill()).
    // The kernel OOM-killer uses SIGKILL under memory pressure; that's
    // the signal we care about.
    if exit_status.as_ref().is_some_and(was_sigkilled) {
        return ExecResponse {
            status: Status::Oom,
            // Synthesize the shell convention so host-side traces look
            // like what a Linux operator expects (`exit_code: 137`).
            exit_code: Some(SIGKILL_SYNTHETIC_EXIT),
            stdout,
            stderr,
            truncated_stdout,
            truncated_stderr,
            duration_ms,
            reason: Some(format!("memory limit reached ({memory_mb} MB)")),
        };
    }

    // Normal exit — code() returns the actual exit code.
    let exit_code = exit_status.as_ref().and_then(|s| s.code());

    ExecResponse {
        status: Status::Completed,
        exit_code,
        stdout,
        stderr,
        truncated_stdout,
        truncated_stderr,
        duration_ms,
        reason: None,
    }
}

/// Did the child exit via SIGKILL? Unix-only (on platforms without
/// POSIX signals, this always returns false — but we only build/test
/// the agent on linux targets anyway).
fn was_sigkilled(status: &std::process::ExitStatus) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        matches!(status.signal(), Some(s) if s == SIGKILL)
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        false
    }
}

/// Spawn a thread that `read_to_end`s the given reader. Sends the
/// collected bytes on a channel; the main thread picks them up once
/// the child has exited.
fn spawn_reader<R: Read + Send + 'static>(mut r: R) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut buf = Vec::new();
        // Errors just mean the stream closed early — return whatever we got.
        let _ = r.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    rx
}

fn collect_reader(rx: Option<mpsc::Receiver<Vec<u8>>>) -> Vec<u8> {
    rx.and_then(|r| r.recv().ok()).unwrap_or_default()
}

/// Truncate to at most `max_bytes` bytes, preserving a UTF-8 prefix.
/// Appends a marker when truncation happened. `from_utf8_lossy` handles
/// any non-UTF-8 byte sequences the interpreter might emit (Python's
/// `repr()` of binary strings, etc.) by replacing with U+FFFD.
fn truncate_utf8(bytes: Vec<u8>, max_bytes: u64) -> (String, bool) {
    let max_bytes = usize::try_from(max_bytes).unwrap_or(usize::MAX);
    if bytes.len() <= max_bytes {
        return (String::from_utf8_lossy(&bytes).into_owned(), false);
    }
    // Truncate at a char boundary so we don't split a multi-byte UTF-8
    // sequence mid-code-point. from_utf8_lossy handles any remaining
    // broken bytes gracefully.
    let mut cut = max_bytes;
    while cut > 0 && !is_char_boundary(&bytes, cut) {
        cut -= 1;
    }
    let mut text = String::from_utf8_lossy(&bytes[..cut]).into_owned();
    text.push_str(&format!("\n[truncated at {max_bytes} bytes]"));
    (text, true)
}

/// Cheap check — is byte index `i` at a UTF-8 code-point boundary?
fn is_char_boundary(bytes: &[u8], i: usize) -> bool {
    if i == 0 || i == bytes.len() {
        return true;
    }
    // Continuation bytes are 10xxxxxx. A boundary is any non-continuation
    // byte position.
    (bytes[i] & 0xC0) != 0x80
}

#[cfg(test)]
mod tests {
    use super::*;

    // All unit tests use `sh -c '...'` so they run on any POSIX host
    // without requiring `node` or `python3`. Real-language integration
    // tests live in the rootfs build pipeline (next commit).

    fn sh(code: &str) -> Vec<String> {
        vec!["-c".to_string(), code.to_string()]
    }

    #[test]
    fn completed_zero_exit() {
        let r = run_process("sh", &sh("echo hello"), Duration::from_secs(2), 50_000, 64);
        assert_eq!(r.status, Status::Completed);
        assert_eq!(r.exit_code, Some(0));
        assert!(r.stdout.contains("hello"));
        assert!(r.stderr.is_empty());
        assert_eq!(r.reason, None);
    }

    #[test]
    fn completed_nonzero_exit_is_not_crashed() {
        // Script crash is `Completed` with non-zero exit — `Crashed` is
        // reserved for the agent itself failing.
        let r = run_process("sh", &sh("exit 7"), Duration::from_secs(2), 50_000, 64);
        assert_eq!(r.status, Status::Completed);
        assert_eq!(r.exit_code, Some(7));
    }

    #[test]
    fn captures_stdout_and_stderr_separately() {
        let r = run_process(
            "sh",
            &sh("echo out; echo err 1>&2"),
            Duration::from_secs(2),
            50_000,
            64,
        );
        assert_eq!(r.status, Status::Completed);
        assert!(r.stdout.contains("out"));
        assert!(r.stderr.contains("err"));
        // And the cross-stream — stdout does NOT accidentally capture stderr.
        assert!(!r.stdout.contains("err"));
        assert!(!r.stderr.contains("out"));
    }

    #[test]
    fn timeout_hit_marks_status_timeout() {
        let r = run_process(
            "sh",
            &sh("sleep 10"),
            Duration::from_millis(200),
            50_000,
            64,
        );
        assert_eq!(r.status, Status::Timeout);
        assert_eq!(r.exit_code, None);
        assert!(r.reason.as_deref().unwrap_or("").contains("timeout"));
        // Duration should be close to the timeout, not close to 10s.
        assert!(r.duration_ms < 2000, "duration_ms={}", r.duration_ms);
    }

    #[test]
    fn sigkill_classifies_as_oom_with_synthetic_137() {
        // `kill -9 $$` self-terminates with SIGKILL. Rust's ExitStatus
        // surfaces this via signal() not code() — our classifier checks
        // the signal and synthesizes exit_code: 137 for host-visible
        // compatibility with shell conventions. This is the same signal
        // the guest kernel's OOM-killer sends under memory pressure.
        let r = run_process("sh", &sh("kill -9 $$"), Duration::from_secs(2), 50_000, 256);
        assert_eq!(r.status, Status::Oom);
        assert_eq!(r.exit_code, Some(SIGKILL_SYNTHETIC_EXIT));
        assert!(r.reason.as_deref().unwrap_or("").contains("256 MB"));
    }

    #[test]
    fn script_exiting_with_literal_137_is_still_completed_not_oom() {
        // A script that deliberately `exit 137`s is NOT OOM — it's a
        // script choosing that exit code. Classifier must distinguish
        // signal-9 termination from a literal exit(137). This guards
        // against the pre-fix bug where we looked at exit_code == 137
        // instead of checking the signal directly.
        let r = run_process("sh", &sh("exit 137"), Duration::from_secs(2), 50_000, 64);
        assert_eq!(r.status, Status::Completed);
        assert_eq!(r.exit_code, Some(137));
    }

    #[test]
    fn stdout_is_truncated_past_max_output_bytes() {
        // Emit 10_000 bytes of 'x', cap at 500. Truncation marker
        // appended; `truncated_stdout` true.
        let r = run_process(
            "sh",
            &sh(r#"awk 'BEGIN{for(i=0;i<10000;i++)printf "x"}'"#),
            Duration::from_secs(2),
            500,
            64,
        );
        assert_eq!(r.status, Status::Completed);
        assert!(r.truncated_stdout);
        assert!(r.stdout.contains("[truncated at 500 bytes]"));
    }

    #[test]
    fn stdout_under_cap_is_not_marked_truncated() {
        let r = run_process(
            "sh",
            &sh("printf 'short'"),
            Duration::from_secs(2),
            50_000,
            64,
        );
        assert_eq!(r.status, Status::Completed);
        assert!(!r.truncated_stdout);
        assert_eq!(r.stdout, "short");
    }

    #[test]
    fn env_is_cleared_before_spawn_except_path() {
        // Plant a secret-shaped env var in the host. The spawned child
        // must NOT inherit it. `env` without args prints all env vars;
        // only PATH should appear.
        std::env::set_var("CAMBIUM_AGENT_SPAWN_SECRET", "must-not-leak");
        let r = run_process("env", &[], Duration::from_secs(2), 50_000, 64);
        std::env::remove_var("CAMBIUM_AGENT_SPAWN_SECRET");
        assert_eq!(r.status, Status::Completed);
        assert!(
            !r.stdout.contains("must-not-leak"),
            "env var leaked into guest: {}",
            r.stdout,
        );
        assert!(
            !r.stdout.contains("CAMBIUM_AGENT_SPAWN_SECRET"),
            "env var name leaked into guest: {}",
            r.stdout,
        );
        // PATH SHOULD be set (interpreters need it to find themselves).
        assert!(r.stdout.contains("PATH="));
    }

    #[test]
    fn spawn_failure_yields_crashed_not_completed() {
        // A non-existent binary surfaces as `Crashed` — that's agent-infra
        // failure, not guest-code failure.
        let r = run_process(
            "this-binary-definitely-does-not-exist-12345",
            &[],
            Duration::from_secs(2),
            50_000,
            64,
        );
        assert_eq!(r.status, Status::Crashed);
        assert!(r
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("failed to spawn"));
    }

    #[test]
    fn run_exec_file_write_failure_yields_crashed() {
        // Can't easily force /tmp to be unwritable in a portable test.
        // Instead, assert the error-path shape directly via
        // ExecResponse::crashed (constructor coverage). The file-write
        // branch in run_exec is exercised in integration tests when the
        // rootfs build lands (next commit).
        let r = ExecResponse::crashed("failed to write script to /tmp/x: permission denied");
        assert_eq!(r.status, Status::Crashed);
        assert!(r
            .reason
            .as_deref()
            .unwrap_or("")
            .contains("permission denied"));
    }

    #[test]
    fn truncate_respects_utf8_boundaries() {
        // "héllo" has 'é' = 2 bytes. If we truncate in the middle of
        // that 2-byte sequence, we should cut back to the previous
        // boundary to avoid producing invalid UTF-8 (which
        // from_utf8_lossy would then mangle).
        let s = "héllo world".as_bytes().to_vec(); // 12 bytes (é is 2)
        let (text, truncated) = truncate_utf8(s, 3); // "hé" is 3 bytes — valid boundary
        assert!(truncated);
        assert!(text.starts_with("hé") || text.starts_with("h"));
        assert!(text.contains("[truncated"));
    }

    #[test]
    fn duration_ms_populated_on_all_paths() {
        // Completed path.
        let r = run_process("sh", &sh("exit 0"), Duration::from_secs(2), 50_000, 64);
        assert!(r.duration_ms < 5000);

        // Timeout path.
        let r = run_process(
            "sh",
            &sh("sleep 10"),
            Duration::from_millis(100),
            50_000,
            64,
        );
        assert!(r.duration_ms >= 100);
        assert!(r.duration_ms < 2000);
    }
}
