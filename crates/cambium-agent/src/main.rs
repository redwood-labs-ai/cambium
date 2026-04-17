//! `cambium-agent` binary — runs inside the guest VM, listens on
//! vsock, dispatches requests, writes responses, then loops back
//! to accept more.
//!
//! The agent never exits voluntarily. It's PID 1 inside the microVM,
//! so returning from main() kernel-panics the guest — and on a panic
//! Firecracker tears the VM down fast enough to race the virtio-vsock
//! flush of whatever response we just wrote. The host decides the
//! VM's lifecycle (via the Firecracker API) after reading the
//! response; the agent's only job is to keep servicing requests
//! until killed.
//!
//! The production target is Linux (AF_VSOCK is a Linux kernel feature).
//! The crate compiles on macOS / Windows for development and test runs,
//! but the binary on those targets just refuses to run with a clear
//! message. The full listen / accept / handle path is Linux-gated.

use std::process::ExitCode;

#[cfg(target_os = "linux")]
fn main() -> ExitCode {
    use cambium_agent::{handle_one, write_frame, ExecResponse, VSOCK_PORT};
    use std::thread;
    use std::time::Duration;
    use vsock::{VsockAddr, VsockListener, VMADDR_CID_ANY};

    eprintln!("cambium-agent: binding vsock CID=VMADDR_CID_ANY port={VSOCK_PORT}");

    let listener = match VsockListener::bind(&VsockAddr::new(VMADDR_CID_ANY, VSOCK_PORT)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cambium-agent: failed to bind vsock: {e}");
            return ExitCode::from(1);
        }
    };

    // Accept loop. One connection per request — the host opens a
    // fresh CONNECT for each exec, we handle it, stream drops at
    // end of iteration (flushing the response through virtio-vsock
    // naturally because the process stays alive), and we loop
    // back to accept the next one. Never returns. If accept() ever
    // fails (shouldn't under normal operation), we log and back off
    // briefly rather than exiting, so a flaky accept can't kill the
    // VM.
    loop {
        let (mut stream, peer) = match listener.accept() {
            Ok(x) => x,
            Err(e) => {
                eprintln!("cambium-agent: accept failed: {e}");
                thread::sleep(Duration::from_millis(100));
                continue;
            }
        };
        eprintln!("cambium-agent: accepted connection from {peer:?}");

        match handle_one(&mut stream) {
            Ok(()) => {
                eprintln!("cambium-agent: request handled");
            }
            Err(e) => {
                eprintln!("cambium-agent: handler error: {e}");
                // Best-effort: if the stream is still writable, send a
                // Crashed response so the host has *something* to classify.
                // If the transport is dead this second write will fail too
                // and the error is just logged.
                let _ = write_frame(&mut stream, &ExecResponse::crashed(format!("agent: {e}")));
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn main() -> ExitCode {
    eprintln!(
        "cambium-agent binary requires Linux (AF_VSOCK). This target ({}) \
         is supported only for development / test builds; the binary \
         itself cannot run here. To iterate on the real path, build \
         for aarch64-unknown-linux-musl or x86_64-unknown-linux-musl \
         and run under Firecracker (see firecracker-testbed/).",
        std::env::consts::OS,
    );
    ExitCode::from(1)
}
