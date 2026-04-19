//! Length-prefixed framing for the vsock wire protocol.
//!
//! Wire shape per RED-255: 4-byte big-endian u32 length header, followed
//! by exactly `len` bytes of JSON payload. One frame per request, one
//! frame per response. No multiplexing, no streaming. The agent is a
//! one-shot-per-VM process; the host destroys the VM after reading the
//! response. This module is stdlib-only (no tokio, no async) because
//! synchronous I/O is the correct shape for that lifecycle.

use serde::{de::DeserializeOwned, Serialize};
use std::io::{self, Read, Write};

/// Maximum size of a single frame's payload in bytes. A malicious or
/// buggy peer could send a header claiming gigabytes of payload; reading
/// it would cause the agent to allocate a huge buffer before it could
/// detect the lie. 100 MB is far more than any realistic code payload
/// while still bounding memory pressure. Configurable later if a driver
/// names a bigger need.
pub const MAX_FRAME_BYTES: usize = 100 * 1024 * 1024;

/// Serialize `payload` as JSON and write it as a length-prefixed frame.
/// The writer is flushed before returning so a short-lived caller can
/// close the socket immediately after.
pub fn write_frame<W, T>(writer: &mut W, payload: &T) -> io::Result<()>
where
    W: Write,
    T: Serialize,
{
    let bytes =
        serde_json::to_vec(payload).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let len: u32 = bytes
        .len()
        .try_into()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame exceeds u32::MAX"))?;
    writer.write_all(&len.to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

/// Read one length-prefixed frame and deserialize it as `T`. Returns
/// `io::Error` with `InvalidData` for oversized frames, truncated
/// payloads, or malformed JSON; `UnexpectedEof` if the reader closes
/// mid-header. The caller decides what to do with the error — the agent's
/// top level treats any frame error as a `Status::Crashed` response.
pub fn read_frame<R, T>(reader: &mut R) -> io::Result<T>
where
    R: Read,
    T: DeserializeOwned,
{
    let mut len_buf = [0u8; 4];
    reader.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf) as usize;

    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "frame size {} bytes exceeds MAX_FRAME_BYTES ({})",
                len, MAX_FRAME_BYTES
            ),
        ));
    }

    let mut payload = vec![0u8; len];
    reader.read_exact(&mut payload)?;
    serde_json::from_slice(&payload).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ExecRequest, ExecResponse, Language, Status};
    use std::io::Cursor;

    #[test]
    fn round_trip_exec_request() {
        let req = ExecRequest {
            language: Language::Js,
            code: "console.log(1+1);".to_string(),
            cpu: 1.0,
            memory_mb: 64,
            timeout_seconds: 5,
            max_output_bytes: 50_000,
            mounts: vec![],
            net: None,
        };

        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, &req).unwrap();

        // Header is 4 bytes; payload length encoded big-endian.
        let len_bytes: [u8; 4] = buf[..4].try_into().unwrap();
        let claimed_len = u32::from_be_bytes(len_bytes) as usize;
        assert_eq!(claimed_len, buf.len() - 4);

        let mut reader = Cursor::new(buf);
        let parsed: ExecRequest = read_frame(&mut reader).unwrap();
        assert_eq!(req, parsed);
    }

    #[test]
    fn round_trip_exec_response() {
        let resp = ExecResponse {
            status: Status::Completed,
            exit_code: Some(0),
            stdout: "2\n".to_string(),
            stderr: String::new(),
            truncated_stdout: false,
            truncated_stderr: false,
            duration_ms: 17,
            reason: None,
        };
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, &resp).unwrap();
        let parsed: ExecResponse = read_frame(&mut Cursor::new(buf)).unwrap();
        assert_eq!(resp, parsed);
    }

    #[test]
    fn rejects_oversized_frame_header() {
        // Header claims 2 GB payload — the limit is 100 MB.
        let mut frame: Vec<u8> = Vec::new();
        let huge: u32 = (MAX_FRAME_BYTES + 1).try_into().unwrap();
        frame.extend_from_slice(&huge.to_be_bytes());

        let err = read_frame::<_, ExecRequest>(&mut Cursor::new(frame))
            .expect_err("oversized frame header must error");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
        assert!(
            err.to_string().contains("exceeds MAX_FRAME_BYTES"),
            "error message should name the cap, got: {err}",
        );
    }

    #[test]
    fn rejects_truncated_payload() {
        // Header says 100 bytes, payload is 5 bytes.
        let mut frame: Vec<u8> = Vec::new();
        frame.extend_from_slice(&100u32.to_be_bytes());
        frame.extend_from_slice(b"short");

        let err = read_frame::<_, ExecRequest>(&mut Cursor::new(frame))
            .expect_err("truncated payload must error");
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn rejects_truncated_header() {
        // Only 2 bytes of header.
        let frame = vec![0x00, 0x01];
        let err = read_frame::<_, ExecRequest>(&mut Cursor::new(frame))
            .expect_err("truncated header must error");
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn rejects_malformed_json() {
        // Header says 7 bytes, payload is 7 bytes of non-JSON.
        let mut frame: Vec<u8> = Vec::new();
        frame.extend_from_slice(&7u32.to_be_bytes());
        frame.extend_from_slice(b"garbage");

        let err = read_frame::<_, ExecRequest>(&mut Cursor::new(frame))
            .expect_err("malformed JSON must error");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn frame_written_can_be_read_by_separate_reader() {
        // Stand-in for the real vsock flow: host writes, guest reads
        // via a different fd/object. The frame format must survive the
        // handoff without relying on the same reader/writer instance.
        let req = ExecRequest {
            language: Language::Python,
            code: "print(42)".to_string(),
            cpu: 1.0,
            memory_mb: 64,
            timeout_seconds: 5,
            max_output_bytes: 50_000,
            mounts: vec![],
            net: None,
        };

        let mut producer: Vec<u8> = Vec::new();
        write_frame(&mut producer, &req).unwrap();

        // Simulate the socket handoff — the reader only sees the bytes.
        let consumer_bytes = producer.clone();
        let parsed: ExecRequest = read_frame(&mut Cursor::new(consumer_bytes)).unwrap();
        assert_eq!(req, parsed);
    }
}
