//! Apply filesystem mounts inside the guest before dispatching the
//! interpreter. Called once per request, between reading the
//! `ExecRequest` and spawning the user's code. Any mount failure
//! aborts the request with a `Crashed` response — we never want to
//! run guest code with a partial mount set, which would silently
//! fail to read files the gen explicitly asked for.
//!
//! v1 supports read-only ext4 mounts only. The host side
//! (`firecracker.ts`, RED-258) attaches one virtio-blk drive per
//! allowlist entry before `InstanceStart`; each drive surfaces in
//! the guest as `/dev/vdb`, `/dev/vdc`, etc. The `ExecRequest.mounts`
//! vec carries `(device, guest_path, read_only)` tuples; the agent
//! rejects any entry with `read_only = false` as a second enforcement
//! point — so a future host bug that leaked a rw mount would fail at
//! the agent rather than silently exposing the host directory
//! writable to guest code.

use crate::protocol::Mount;
use std::process::Command;

/// Absolute path to the `mount(8)` binary inside the guest rootfs.
/// Hardcoded to `/bin/mount` because the agent's own env has no
/// PATH set (it's PID 1; kernel cmdline doesn't populate PATH). On
/// Alpine + busybox this is a symlink to `/bin/busybox`, which
/// supports `mount -t ext4`. If the reference rootfs ever migrates
/// to a base where mount lives elsewhere, update this + the preflight
/// together.
const MOUNT_BIN: &str = "/bin/mount";

/// Apply every mount in `mounts` sequentially. On any failure,
/// return an error string describing which mount failed and why.
///
/// The VM is destroyed per-call, so we don't bother unmounting on
/// exit or cleaning up partial state — the caller treats a partial
/// mount set as a hard failure and returns `Crashed` without running
/// the interpreter.
///
/// v1 only supports read-only; a `read_only: false` mount still
/// mounts but the host-side policy enforces the flag before the
/// request is built.
pub fn apply_mounts(mounts: &[Mount]) -> Result<(), String> {
    for (idx, m) in mounts.iter().enumerate() {
        // Belt-and-suspenders: v1 only supports read-only mounts.
        // The host builds the ExecRequest and is supposed to hardcode
        // `read_only: true` for every allowlist entry (see
        // `normalizeAllowlistPaths` in
        // `packages/cambium-runner/src/exec-substrate/firecracker-allowlist.ts`).
        // But a future host-side refactor that misplaces the hardcoding
        // could send `read_only: false` and the agent would silently
        // mount rw. Reject here so the agent is a second enforcement
        // point, not a pass-through.
        if !m.read_only {
            return Err(format!(
                "mount[{idx}]: {} -> {} requested read_only=false, which the agent refuses — \
                 v1 allowlist mounts are read-only only",
                m.device, m.guest_path,
            ));
        }

        // Ensure the mount point exists. `create_dir_all` is the
        // moral equivalent of `mkdir -p`; it's idempotent and handles
        // intermediate directories.
        std::fs::create_dir_all(&m.guest_path).map_err(|e| {
            format!(
                "mount[{idx}]: mkdir -p {} failed: {e}",
                m.guest_path
            )
        })?;

        // Build the mount command. v1 always passes `-t ext4`
        // explicitly — busybox's mount(1) can't auto-detect
        // filesystem type without `blkid`, which Alpine's minimal
        // busybox doesn't include. Confirmed via RED-258 preflight
        // on the MS-R1 (2026-04-19).
        let mut cmd = Command::new(MOUNT_BIN);
        cmd.args(["-t", "ext4", "-o", "ro"]);
        cmd.args([&m.device, &m.guest_path]);

        let output = cmd.output().map_err(|e| {
            format!("mount[{idx}]: spawn {MOUNT_BIN} failed: {e}")
        })?;

        if !output.status.success() {
            // mount writes its error to stderr; include it verbatim
            // so the host trace has a direct diagnostic.
            let stderr = String::from_utf8_lossy(&output.stderr);
            let status = output
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "killed-by-signal".to_string());
            return Err(format!(
                "mount[{idx}]: {} -> {} (exit {}): {}",
                m.device,
                m.guest_path,
                status,
                stderr.trim(),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Empty mount list is a no-op success. The common case — gens
    /// that don't need filesystem access send an empty `mounts` vec
    /// (or omit it entirely; serde gives us `vec![]` by default).
    #[test]
    fn empty_mounts_is_ok() {
        assert!(apply_mounts(&[]).is_ok());
    }

    /// mkdir failure surfaces with the target path in the message so
    /// a trace consumer can tell WHICH mount broke. We can't easily
    /// force mkdir to fail on the test host, but passing an obviously-
    /// impossible path (a null byte mid-string) triggers the OS-level
    /// error path for any Unix.
    #[test]
    fn mkdir_failure_is_reported_with_path_context() {
        let bad = Mount {
            device: "/dev/vdb".to_string(),
            guest_path: "/tmp/has\0null".to_string(),
            read_only: true,
        };
        let err = apply_mounts(&[bad]).expect_err("null-byte path must fail");
        assert!(err.contains("mkdir -p"), "err: {err}");
        assert!(err.starts_with("mount[0]:"), "err: {err}");
    }

    /// Belt-and-suspenders: if the host-side ever leaks `read_only:
    /// false` on a mount, the agent refuses the whole request rather
    /// than silently mounting rw. The error must fire BEFORE mkdir
    /// runs, so we can use a guest_path that would succeed mkdir —
    /// what we're asserting is that the rw check is the first gate.
    #[test]
    fn refuses_read_only_false_without_attempting_mkdir() {
        let rw = Mount {
            device: "/dev/vdb".to_string(),
            guest_path: "/tmp/cambium-agent-rw-refusal-check".to_string(),
            read_only: false,
        };
        let err = apply_mounts(&[rw]).expect_err("rw mount must be refused");
        assert!(err.contains("read_only=false"), "err: {err}");
        assert!(err.contains("refuses"), "err: {err}");
        assert!(err.starts_with("mount[0]:"), "err: {err}");
        // The guard runs before mkdir, so the path we supplied
        // shouldn't have been created on the test host.
        assert!(
            !std::path::Path::new("/tmp/cambium-agent-rw-refusal-check").exists(),
            "rw guard ran mkdir before refusing — the guard is in the wrong position",
        );
    }

    // NOTE: We don't test the happy path here (actual mount succeeds)
    // because that requires real block devices + root privileges. The
    // test coverage for that lives in `firecracker-testbed/` — the
    // escape-test matrix under RED-257, extended by RED-258 with an
    // allowlisted-vs-not-allowlisted pair, exercises real mounts in
    // a real VM. Unit tests here only cover the error paths that are
    // reachable in-process.
}
