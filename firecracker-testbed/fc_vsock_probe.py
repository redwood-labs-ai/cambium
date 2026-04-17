#!/usr/bin/env python3
"""
Firecracker vsock probe — host-side smoke client (RED-255).

Connects to the parent Firecracker vsock UDS, negotiates a
CONNECT to the guest listener port, frames one `ExecRequest` to
the cambium-agent running inside the microVM, reads back one
`ExecResponse`, and validates the shape + payload.

Exit code is 0 on a successful round-trip that satisfies the
expectations baked in below; any deviation exits non-zero with a
diagnostic on stderr. Only stdlib — this runs inside the testbed
container alongside firecracker and curl.

Not a general-purpose client. Its only job is to prove
    host UDS → vsock → guest agent → interpreter → response
works end-to-end. The host-side `FirecrackerSubstrate` that lands
next as part of the production substrate will talk the same
protocol but carry full runner plumbing around it.
"""

import json
import os
import socket
import struct
import sys
import time

UDS = os.environ.get("FC_VSOCK_UDS", "/tmp/fc-vsock.sock")
PORT = int(os.environ.get("FC_VSOCK_PORT", "52717"))
CONNECT_DEADLINE_SECONDS = float(os.environ.get("FC_CONNECT_DEADLINE", "20"))
RESPONSE_DEADLINE_SECONDS = float(os.environ.get("FC_RESPONSE_DEADLINE", "30"))

FRAME_HEADER = struct.Struct(">I")
MAX_FRAME_BYTES = 100 * 1024 * 1024  # mirror agent's MAX_FRAME_BYTES

# A deliberately trivial program — any response payload that contains
# the marker AND exits 0 proves the whole pipeline is alive. Using JS
# because Node starts faster than CPython from cold in a tight VM.
EXPECTED_MARKER = "hello from cambium-agent"
EXEC_REQUEST = {
    "language": "js",
    "code": f"console.log({EXPECTED_MARKER!r})",
    "cpu": 1.0,
    "memory_mb": 128,
    "timeout_seconds": 10,
    "max_output_bytes": 65_536,
}


def log(msg: str) -> None:
    print(f"[probe] {msg}", flush=True)


def err(msg: str) -> None:
    print(f"[probe] {msg}", file=sys.stderr, flush=True)


def write_frame(sock: socket.socket, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    sock.sendall(FRAME_HEADER.pack(len(body)))
    sock.sendall(body)


def read_exactly(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise EOFError(
                f"peer closed after {len(buf)} bytes, expected {n}"
            )
        buf.extend(chunk)
    return bytes(buf)


def read_frame(sock: socket.socket) -> dict:
    header = read_exactly(sock, FRAME_HEADER.size)
    (length,) = FRAME_HEADER.unpack(header)
    if length == 0:
        raise ValueError("agent sent empty frame")
    if length > MAX_FRAME_BYTES:
        raise ValueError(
            f"agent sent oversized frame: {length} > {MAX_FRAME_BYTES}"
        )
    body = read_exactly(sock, length)
    return json.loads(body.decode("utf-8"))


def negotiate_connect(sock: socket.socket, port: int) -> str:
    """
    Firecracker's host-initiated vsock protocol: after connecting
    to the parent UDS, send `CONNECT <port>\\n`; Firecracker
    forwards the connection to the guest listener on that port
    and replies with `OK <backend_port>\\n` on success. If no
    guest listener exists yet, Firecracker closes the host-side
    UDS — this surfaces as EOFError on the read below.
    """
    sock.sendall(f"CONNECT {port}\n".encode())
    line = bytearray()
    while True:
        b = sock.recv(1)
        if not b:
            raise EOFError("peer closed before CONNECT response")
        line.extend(b)
        if b == b"\n":
            break
        if len(line) > 128:
            raise ValueError(
                f"CONNECT response too long: {bytes(line)!r}"
            )
    text = bytes(line).decode("ascii", errors="replace").strip()
    if not text.startswith("OK "):
        raise RuntimeError(f"vsock CONNECT rejected: {text!r}")
    return text


def dial_and_handshake(
    uds_path: str, port: int, deadline: float
) -> "tuple[socket.socket, str]":
    """
    Retry the full UDS-open + CONNECT handshake until it succeeds
    or the deadline expires. Retrying just the UDS open isn't
    enough: the parent UDS appears as soon as `PUT /vsock` lands
    (before boot), but the guest-side vsock listener doesn't
    come up until the kernel's finished booting, rootfs has
    mounted, and the agent's reached its accept loop — a window
    that's several seconds on cold Alpine. During that window
    the UDS connects cleanly but Firecracker closes on our
    CONNECT write, so we need to reopen + resend, not just
    reopen.
    """
    last_err = None
    while time.monotonic() < deadline:
        sock = None
        try:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(2.0)
            sock.connect(uds_path)
            reply = negotiate_connect(sock, port)
            return sock, reply
        except (
            FileNotFoundError,
            ConnectionRefusedError,
            EOFError,
            RuntimeError,
            ValueError,
            socket.timeout,
            OSError,
        ) as e:
            last_err = e
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
        time.sleep(0.5)
    raise TimeoutError(
        f"could not establish vsock session to {uds_path} port "
        f"{port} within {CONNECT_DEADLINE_SECONDS:.1f}s: "
        f"last error: {last_err!r}"
    )


def validate_response(resp: dict) -> None:
    status = resp.get("status")
    if status != "completed":
        raise AssertionError(
            f"status = {status!r} (expected 'completed'); "
            f"reason = {resp.get('reason')!r}; "
            f"stderr = {resp.get('stderr')!r}"
        )
    exit_code = resp.get("exit_code")
    if exit_code != 0:
        raise AssertionError(
            f"exit_code = {exit_code!r} (expected 0); "
            f"stderr = {resp.get('stderr')!r}"
        )
    stdout = resp.get("stdout", "")
    if EXPECTED_MARKER not in stdout:
        raise AssertionError(
            f"stdout missing marker {EXPECTED_MARKER!r}; "
            f"got stdout = {stdout!r}"
        )


def main() -> int:
    log(f"dialing {UDS} (deadline {CONNECT_DEADLINE_SECONDS:.1f}s)")
    deadline = time.monotonic() + CONNECT_DEADLINE_SECONDS
    sock, reply = dial_and_handshake(UDS, PORT, deadline)
    sock.settimeout(RESPONSE_DEADLINE_SECONDS)
    log(f"vsock OK: {reply}")

    write_frame(sock, EXEC_REQUEST)
    log(
        f"sent ExecRequest (language={EXEC_REQUEST['language']}, "
        f"{len(EXEC_REQUEST['code'])} bytes of code)"
    )

    resp = read_frame(sock)
    log(
        f"received ExecResponse: status={resp.get('status')!r} "
        f"exit_code={resp.get('exit_code')!r} "
        f"duration_ms={resp.get('duration_ms')!r}"
    )
    if resp.get("stdout"):
        log(f"  stdout: {resp['stdout']!r}")
    if resp.get("stderr"):
        log(f"  stderr: {resp['stderr']!r}")

    try:
        validate_response(resp)
    except AssertionError as e:
        err(f"response did not meet expectations: {e}")
        return 1

    log("round-trip OK")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        err(f"probe failed: {type(e).__name__}: {e}")
        sys.exit(1)
