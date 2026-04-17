//! `cambium-agent` binary — runs inside the guest VM, waits for one
//! request over vsock, dispatches it, writes the response, exits.
//!
//! The production target is Linux (AF_VSOCK is a Linux kernel feature).
//! The crate compiles on macOS / Windows for development and test runs,
//! but the binary on those targets just refuses to run with a clear
//! message. The full listen / accept / handle path is Linux-gated.

use std::process::ExitCode;

#[cfg(target_os = "linux")]
fn main() -> ExitCode {
    use cambium_agent::{handle_one, write_frame, ExecResponse, VSOCK_PORT};
    use vsock::{VsockAddr, VsockListener, VMADDR_CID_ANY};

    eprintln!("cambium-agent: binding vsock CID=VMADDR_CID_ANY port={VSOCK_PORT}");

    let listener = match VsockListener::bind(&VsockAddr::new(VMADDR_CID_ANY, VSOCK_PORT)) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("cambium-agent: failed to bind vsock: {e}");
            return ExitCode::from(1);
        }
    };

    // One-shot by design — the host destroys the VM after reading the
    // response, so accepting a second connection is pointless.
    let (mut stream, peer) = match listener.accept() {
        Ok(x) => x,
        Err(e) => {
            eprintln!("cambium-agent: accept failed: {e}");
            return ExitCode::from(1);
        }
    };
    eprintln!("cambium-agent: accepted connection from {peer:?}");

    match handle_one(&mut stream) {
        Ok(()) => {
            eprintln!("cambium-agent: request handled, exiting");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("cambium-agent: handler error: {e}");
            // Best-effort: if the stream is still writable, send a
            // Crashed response so the host has *something* to classify.
            // If the transport is dead this second write will fail too
            // and the error is just logged.
            let _ = write_frame(&mut stream, &ExecResponse::crashed(format!("agent: {e}")));
            ExitCode::from(1)
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
