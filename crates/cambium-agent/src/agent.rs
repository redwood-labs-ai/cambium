//! Per-request handler — the logic that wraps one Read+Write stream
//! and turns it into "read an ExecRequest, run it, write an
//! ExecResponse, exit." The stream is generic so the same code path
//! handles a real vsock connection in production and a `Cursor<Vec<u8>>`
//! or `UnixStream` pair in tests, without bringing vsock into the
//! unit-test story (AF_VSOCK is Linux-only; tests need to run on
//! macOS developer machines too).

use std::io::{Read, Write};

use crate::frame::{read_frame, write_frame};
use crate::mounts::apply_mounts;
use crate::protocol::{ExecRequest, ExecResponse};
use crate::spawn::run_exec;

/// Handle exactly one request/response cycle on `stream`. The caller
/// is responsible for closing / destroying the transport after — the
/// agent is one-shot-per-VM by design.
///
/// Returns `Ok(())` iff both the request was read successfully AND
/// the response was written successfully. Any transport-level failure
/// returns `Err` with a human-readable message; the binary logs it
/// and exits non-zero.
///
/// Note that a *guest crash* (the interpreter returning non-zero,
/// timing out, OOM-killed, etc.) is NOT a handler error — it's a
/// valid `ExecResponse` with an appropriate `Status`, which is what
/// `run_exec` already returns. The handler's error path covers only
/// frame-read or frame-write failures, which almost certainly mean
/// the host is gone or the socket is dead; nothing sensible to do
/// but exit.
pub fn handle_one<S: Read + Write>(stream: &mut S) -> Result<(), String> {
    let request: ExecRequest =
        read_frame(stream).map_err(|e| format!("failed to read ExecRequest: {e}"))?;

    // Apply allowlist mounts before spawning the interpreter. A mount
    // failure aborts the request with a Crashed response; we never
    // want to run guest code with a partial mount set (some paths
    // silently missing would look like ENOENT to the gen, which
    // would falsely look like "file doesn't exist on host"). See
    // RED-258 for the full design.
    if !request.mounts.is_empty() {
        if let Err(e) = apply_mounts(&request.mounts) {
            let response = ExecResponse::crashed(format!("mount setup failed: {e}"));
            write_frame(stream, &response)
                .map_err(|e| format!("failed to write ExecResponse: {e}"))?;
            return Ok(());
        }
    }

    let response = run_exec(&request);

    write_frame(stream, &response).map_err(|e| format!("failed to write ExecResponse: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ExecResponse, Language, Status};
    use std::io::Cursor;

    /// Build a `Cursor<Vec<u8>>` pre-filled with one framed request.
    /// After `handle_one` runs, the same cursor contains the response
    /// bytes appended after the request (the cursor position advances
    /// linearly through reads + writes). Tests extract the response
    /// by seeking back to the post-request position.
    fn framed_request_stream(req: &ExecRequest) -> (Cursor<Vec<u8>>, usize) {
        let mut buf = Vec::new();
        write_frame(&mut buf, req).unwrap();
        let request_len = buf.len();
        let cursor = Cursor::new({
            // Preallocate some slack so subsequent writes don't need to
            // grow the vec mid-test (avoids a reallocation that could
            // mask buffer-aliasing bugs).
            let mut v = buf;
            v.reserve(4096);
            v
        });
        (cursor, request_len)
    }

    fn read_response_from(cursor: &mut Cursor<Vec<u8>>, response_start: usize) -> ExecResponse {
        cursor.set_position(response_start as u64);
        read_frame(cursor).expect("response frame read")
    }

    #[test]
    fn handle_one_runs_a_js_request_via_sh_surrogate() {
        // We can't run a real `node` in a unit test — that's what the
        // rootfs build validates. Here we assert the handler plumbs a
        // request through to spawn correctly by requesting a JS
        // snippet; if `node` isn't installed we expect a Crashed
        // response (which is still a successful *handler* outcome —
        // the response was read + written cleanly).
        let req = ExecRequest {
            language: Language::Js,
            code: "console.log('hi')".to_string(),
            cpu: 1.0,
            memory_mb: 64,
            timeout_seconds: 5,
            max_output_bytes: 10_000,
            mounts: vec![],
        };
        let (mut cursor, response_start) = framed_request_stream(&req);

        handle_one(&mut cursor).expect("handler returns Ok even if interpreter missing");

        let resp = read_response_from(&mut cursor, response_start);
        // Status is either Completed (if node is on PATH) or Crashed
        // (if the spawn failed because node isn't installed). Both are
        // valid *handler* outcomes — the transport worked either way.
        assert!(matches!(resp.status, Status::Completed | Status::Crashed));
    }

    #[test]
    fn handle_one_returns_err_when_request_frame_is_malformed() {
        // A cursor with garbage bytes → read_frame fails → handler
        // returns Err. The binary's main loop logs and exits nonzero.
        let mut cursor = Cursor::new(b"not a valid length-prefixed frame".to_vec());
        let err = handle_one(&mut cursor).expect_err("malformed input must surface as Err");
        assert!(err.contains("failed to read ExecRequest"), "got: {err}");
    }

    #[test]
    fn handle_one_returns_err_when_stream_eof_mid_header() {
        // Truncated 4-byte header (only 2 bytes).
        let mut cursor = Cursor::new(vec![0x00, 0x00]);
        let err = handle_one(&mut cursor).expect_err("truncated header must surface as Err");
        assert!(err.contains("failed to read ExecRequest"), "got: {err}");
    }

    #[test]
    fn handle_one_produces_a_well_formed_response_frame() {
        // Regardless of what `run_exec` returns, the handler must
        // produce a parseable response frame (length header + JSON
        // payload). A broken response frame would leave the host
        // unable to recover any diagnostic info.
        let req = ExecRequest {
            language: Language::Python, // python3 might not be installed; either way we get a frame
            code: "print('hi')".to_string(),
            cpu: 1.0,
            memory_mb: 64,
            timeout_seconds: 5,
            max_output_bytes: 10_000,
            mounts: vec![],
        };
        let (mut cursor, response_start) = framed_request_stream(&req);

        handle_one(&mut cursor).expect("handler Ok");

        // Extract the response and verify its shape.
        cursor.set_position(response_start as u64);
        let resp: ExecResponse = read_frame(&mut cursor).expect("response frame parseable");
        // All ExecResponse fields present and typed — serde's
        // deserialization catches any shape regression.
        let _ = resp.status;
        let _ = resp.duration_ms;
    }

    #[test]
    fn handle_one_does_not_panic_on_unicode_heavy_request() {
        // Emoji and wide characters in the code field — the frame
        // reader must not mis-count bytes vs chars, and the handler
        // must not panic on any UTF-8 sequence.
        let req = ExecRequest {
            language: Language::Js,
            code: "console.log('🦀 + 日本語 + αβγ')".to_string(),
            cpu: 1.0,
            memory_mb: 64,
            timeout_seconds: 5,
            max_output_bytes: 10_000,
            mounts: vec![],
        };
        let (mut cursor, _) = framed_request_stream(&req);
        handle_one(&mut cursor).expect("unicode handled without panic");
    }
}
