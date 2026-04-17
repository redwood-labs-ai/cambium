//! `cambium-agent` binary entry.
//!
//! First-commit skeleton: exits non-zero with a clear "not yet wired"
//! message so accidentally baking this build into a rootfs doesn't
//! silently succeed. The actual listener + spawn loop lands in the
//! next commit on this branch, once the protocol + framing layers are
//! reviewed (this one is just those two).

use std::process::ExitCode;

fn main() -> ExitCode {
    eprintln!(
        "cambium-agent: protocol + framing only in this commit; \
         vsock listener + interpreter spawn arrive in the next commit \
         on RED-255/rust-agent. Do not bake this build into a rootfs yet."
    );
    ExitCode::from(2)
}
