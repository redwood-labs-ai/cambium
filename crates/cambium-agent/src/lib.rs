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

pub mod agent;
pub mod frame;
pub mod mounts;
pub mod net;
pub mod protocol;
pub mod spawn;

pub use agent::handle_one;
pub use frame::{read_frame, write_frame, MAX_FRAME_BYTES};
pub use mounts::apply_mounts;
pub use net::apply_net_config;
pub use protocol::{ExecRequest, ExecResponse, HostMapping, Language, Mount, NetConfig, Status};
pub use spawn::{run_exec, run_process};

/// The vsock port the agent listens on inside the guest. Host side
/// must connect to this port to hand off a request. Pinned here (not
/// in main.rs) so both the binary and any future host-side crate can
/// import it from the same source of truth. Value chosen arbitrarily
/// in the 49152-65535 dynamic range — nothing magic about the number
/// beyond "it's a constant both ends must agree on."
pub const VSOCK_PORT: u32 = 52717;
