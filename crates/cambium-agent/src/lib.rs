//! `cambium-agent` — guest-side agent for Cambium's `:firecracker` exec
//! substrate (RED-251 / RED-255).
//!
//! Runs inside the sandbox microVM. Listens on vsock, reads a single
//! length-prefixed JSON `ExecRequest`, writes the user code to a temp
//! file, spawns the matching interpreter (`node` or `python3`), captures
//! stdout/stderr with byte caps, and writes a single `ExecResponse`
//! back over the same socket. One request per VM by design — the host
//! destroys the VM after reading the response.
//!
//! This library crate exposes the protocol + framing + (forthcoming)
//! spawn/run logic so they can be exercised by unit tests without
//! bringing in vsock or a real interpreter. The `cambium-agent` binary
//! (`src/main.rs`) is a thin wrapper around the listener loop.

pub mod frame;
pub mod protocol;
pub mod spawn;

pub use frame::{read_frame, write_frame, MAX_FRAME_BYTES};
pub use protocol::{ExecRequest, ExecResponse, Language, Status};
pub use spawn::{run_exec, run_process};
