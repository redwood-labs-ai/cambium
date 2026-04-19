//! Apply network configuration inside the guest before dispatching
//! the interpreter. Called once per request when `ExecRequest.net` is
//! `Some`, between reading the `ExecRequest` and applying filesystem
//! mounts. Any failure aborts the request with a `Crashed` response —
//! we never want to run guest code with a half-configured network,
//! which would silently fail to reach hosts the gen expects to be
//! reachable.
//!
//! v1 supports static IP assignment on `eth0` plus a default route
//! and a set of pre-resolved `/etc/hosts` entries. The host side
//! (`firecracker.ts`, RED-259) creates the netns + veth + tap +
//! iptables allowlist, pre-resolves hostnames, and sends the agent
//! the concrete shape. The agent just obeys — no DNS resolution, no
//! iptables manipulation, no interface creation. That split keeps
//! the security surface where it belongs (the host) and the guest
//! agent small + boring.

use crate::protocol::{HostMapping, NetConfig};
use std::path::Path;
use std::process::Command;

/// Absolute path to the busybox binary — same rationale as MOUNT_BIN
/// in `mounts.rs`: the agent's env has no PATH populated (it's PID 1
/// with no kernel-cmdline PATH), so every external command it spawns
/// has to name its binary absolutely. Busybox carries the `ifconfig`,
/// `route`, and other network applets needed here. The RED-259
/// preflight (2026-04-19) confirmed the applets are compiled in but
/// not always symlinked; invoking as `busybox <applet>` is the
/// reliable path.
const BUSYBOX_BIN: &str = "/bin/busybox";

/// Default location of `/etc/hosts` inside the guest. Injectable in
/// tests via `apply_net_config_with_paths` — tests use a tempfile so
/// they don't need root + don't clobber the test host.
const DEFAULT_HOSTS_PATH: &str = "/etc/hosts";

/// Apply the requested NetConfig. Returns a human-readable error
/// describing which step failed. The agent treats any error as a
/// hard failure and returns a `Crashed` response.
///
/// Steps (in order):
///   1. Parse `iface_ip` (CIDR form) into (ip, dotted-decimal netmask).
///   2. `busybox ifconfig eth0 <ip> netmask <mask> up`.
///   3. `busybox route add default gw <gateway>`.
///   4. Append each `HostMapping` to `/etc/hosts`.
///
/// Steps 2 and 3 are intentionally not combined or reordered: the
/// preflight showed that bringing the interface up FIRST lets the
/// route add succeed; bringing it up after the route add errors with
/// "Network is unreachable".
pub fn apply_net_config(cfg: &NetConfig) -> Result<(), String> {
    apply_net_config_with_paths(cfg, Path::new(DEFAULT_HOSTS_PATH))
}

/// Test-friendly variant. Takes the `/etc/hosts` path so tests can
/// point it at a tempfile without spawning busybox (the real command
/// invocation is skipped when an injected path is used — see
/// `_apply_net_config_inner` below).
pub fn apply_net_config_with_paths(
    cfg: &NetConfig,
    hosts_path: &Path,
) -> Result<(), String> {
    // Validate CIDR up front — if this fails we don't want to have
    // already run ifconfig.
    let (ip, netmask) = parse_cidr(&cfg.iface_ip)?;
    validate_gateway(&cfg.gateway)?;

    run_busybox(&build_ifconfig_args(&ip, &netmask))
        .map_err(|e| format!("ifconfig eth0 {}/{}: {}", ip, netmask, e))?;
    run_busybox(&build_route_args(&cfg.gateway))
        .map_err(|e| format!("route add default gw {}: {}", cfg.gateway, e))?;

    append_hosts_entries(hosts_path, &cfg.hosts)
        .map_err(|e| format!("append /etc/hosts: {}", e))?;

    Ok(())
}

/// Parse `"10.200.0.2/24"` → `("10.200.0.2", "255.255.255.0")`.
/// Rejects missing slash, out-of-range prefix, non-integer prefix,
/// malformed IP. The IP check is intentionally loose (four dotted
/// u8 octets) — strict validation lives in the host-side TS policy
/// layer where the caller-visible error is useful; here we just
/// catch shapes that would make ifconfig argument construction
/// silently wrong.
pub fn parse_cidr(cidr: &str) -> Result<(String, String), String> {
    let (ip, prefix_str) = cidr
        .split_once('/')
        .ok_or_else(|| format!("iface_ip missing /prefix: {:?}", cidr))?;
    let prefix: u32 = prefix_str
        .parse()
        .map_err(|_| format!("iface_ip has non-integer prefix: {:?}", cidr))?;
    if prefix > 32 {
        return Err(format!("iface_ip prefix {} > 32", prefix));
    }
    validate_ip_octets(ip).map_err(|e| format!("iface_ip: {}", e))?;

    // Prefix length → dotted-decimal netmask. `shl` by 32 would be
    // well-defined in Rust (saturating to 0) but makes the intent
    // harder to read; branch on prefix==0 explicitly.
    let mask: u32 = if prefix == 0 {
        0
    } else {
        // Safe: 1 <= prefix <= 32, so (32 - prefix) is in [0, 31].
        0xFFFFFFFFu32 << (32 - prefix)
    };
    let netmask = format!(
        "{}.{}.{}.{}",
        (mask >> 24) & 0xff,
        (mask >> 16) & 0xff,
        (mask >> 8) & 0xff,
        mask & 0xff,
    );
    Ok((ip.to_string(), netmask))
}

/// Loose validation that `s` is four dotted `0..=255` octets. Rejects
/// "", "10", "10.0.0.0.0", "10.a.b.c", etc.
fn validate_ip_octets(s: &str) -> Result<(), String> {
    let octets: Vec<&str> = s.split('.').collect();
    if octets.len() != 4 {
        return Err(format!("expected 4 octets, got {}: {:?}", octets.len(), s));
    }
    for o in &octets {
        o.parse::<u8>()
            .map_err(|_| format!("non-u8 octet in {:?}", s))?;
    }
    Ok(())
}

fn validate_gateway(gw: &str) -> Result<(), String> {
    validate_ip_octets(gw).map_err(|e| format!("gateway: {}", e))
}

/// Build the argv for `busybox ifconfig eth0 <ip> netmask <mask> up`.
/// Pure function so tests can assert the argument shape without
/// spawning anything.
pub fn build_ifconfig_args(ip: &str, netmask: &str) -> Vec<String> {
    vec![
        "ifconfig".to_string(),
        "eth0".to_string(),
        ip.to_string(),
        "netmask".to_string(),
        netmask.to_string(),
        "up".to_string(),
    ]
}

/// Build the argv for `busybox route add default gw <gateway>`.
pub fn build_route_args(gateway: &str) -> Vec<String> {
    vec![
        "route".to_string(),
        "add".to_string(),
        "default".to_string(),
        "gw".to_string(),
        gateway.to_string(),
    ]
}

/// Append each HostMapping to `path`, preserving whatever's already
/// there (the Alpine rootfs ships `/etc/hosts` with a `127.0.0.1
/// localhost` line we must keep). No-op on empty input.
///
/// Returns an error rather than partial writes on I/O failure — if
/// the agent can't finish writing /etc/hosts, the gen's DNS lookups
/// will be inconsistent, which is worse than failing fast.
pub fn append_hosts_entries(path: &Path, hosts: &[HostMapping]) -> Result<(), String> {
    if hosts.is_empty() {
        return Ok(());
    }
    let mut content = std::fs::read_to_string(path)
        .unwrap_or_default(); // missing file is fine — we'll create it
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    for h in hosts {
        // Basic sanity: reject hostname/IP with newline or NUL. A
        // malformed entry would corrupt /etc/hosts and potentially
        // break unrelated resolvers inside the guest.
        if h.name.contains('\n') || h.name.contains('\0') {
            return Err(format!("HostMapping.name has forbidden control char: {:?}", h.name));
        }
        if h.ip.contains('\n') || h.ip.contains('\0') {
            return Err(format!("HostMapping.ip has forbidden control char: {:?}", h.ip));
        }
        content.push_str(&format!("{} {}\n", h.ip, h.name));
    }
    std::fs::write(path, content)
        .map_err(|e| format!("write {}: {}", path.display(), e))?;
    Ok(())
}

fn run_busybox(args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(BUSYBOX_BIN);
    cmd.args(args);
    let output = cmd
        .output()
        .map_err(|e| format!("spawn {} failed: {}", BUSYBOX_BIN, e))?;
    if !output.status.success() {
        let stderr_raw = String::from_utf8_lossy(&output.stderr);
        let stderr_trimmed = stderr_raw.trim();
        let stderr_msg = if stderr_trimmed.is_empty() { "(no stderr)" } else { stderr_trimmed };
        let status = output
            .status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "killed-by-signal".to_string());
        return Err(format!("exit {}: {}", status, stderr_msg));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn parse_cidr_24() {
        assert_eq!(
            parse_cidr("10.200.0.2/24").unwrap(),
            ("10.200.0.2".to_string(), "255.255.255.0".to_string()),
        );
    }

    #[test]
    fn parse_cidr_32() {
        assert_eq!(
            parse_cidr("10.0.0.1/32").unwrap(),
            ("10.0.0.1".to_string(), "255.255.255.255".to_string()),
        );
    }

    #[test]
    fn parse_cidr_16() {
        assert_eq!(
            parse_cidr("172.16.5.5/16").unwrap(),
            ("172.16.5.5".to_string(), "255.255.0.0".to_string()),
        );
    }

    #[test]
    fn parse_cidr_8() {
        assert_eq!(
            parse_cidr("10.0.0.1/8").unwrap(),
            ("10.0.0.1".to_string(), "255.0.0.0".to_string()),
        );
    }

    #[test]
    fn parse_cidr_rejects_missing_slash() {
        let err = parse_cidr("10.0.0.1").unwrap_err();
        assert!(err.contains("missing /prefix"), "got: {err}");
    }

    #[test]
    fn parse_cidr_rejects_out_of_range_prefix() {
        let err = parse_cidr("10.0.0.1/33").unwrap_err();
        assert!(err.contains("> 32"), "got: {err}");
    }

    #[test]
    fn parse_cidr_rejects_non_integer_prefix() {
        let err = parse_cidr("10.0.0.1/abc").unwrap_err();
        assert!(err.contains("non-integer prefix"), "got: {err}");
    }

    #[test]
    fn parse_cidr_rejects_bad_ip() {
        let err = parse_cidr("10.0.0.300/24").unwrap_err();
        assert!(err.contains("iface_ip"), "got: {err}");
    }

    #[test]
    fn parse_cidr_rejects_wrong_octet_count() {
        let err = parse_cidr("10.0.0/24").unwrap_err();
        assert!(err.contains("iface_ip"), "got: {err}");
    }

    #[test]
    fn validate_gateway_accepts_ipv4() {
        assert!(validate_gateway("10.200.0.1").is_ok());
    }

    #[test]
    fn validate_gateway_rejects_hostname() {
        let err = validate_gateway("gateway.local").unwrap_err();
        assert!(err.contains("gateway"), "got: {err}");
    }

    #[test]
    fn ifconfig_args_shape() {
        let args = build_ifconfig_args("10.200.0.2", "255.255.255.0");
        assert_eq!(args, vec!["ifconfig", "eth0", "10.200.0.2", "netmask", "255.255.255.0", "up"]);
    }

    #[test]
    fn route_args_shape() {
        let args = build_route_args("10.200.0.1");
        assert_eq!(args, vec!["route", "add", "default", "gw", "10.200.0.1"]);
    }

    #[test]
    fn append_hosts_entries_preserves_existing() {
        // Scenario: Alpine's /etc/hosts ships with a 127.0.0.1
        // localhost line. Appending allowlist entries must not clobber
        // it — the guest still needs localhost to resolve for its
        // own internal loopback.
        let tmp = tempfile_with_content("127.0.0.1\tlocalhost\n");
        let hosts = vec![
            HostMapping { name: "api.github.com".into(), ip: "140.82.112.6".into() },
            HostMapping { name: "cdn.example.com".into(), ip: "151.101.1.57".into() },
        ];
        append_hosts_entries(tmp.path(), &hosts).unwrap();
        let result = std::fs::read_to_string(tmp.path()).unwrap();
        assert!(result.contains("127.0.0.1\tlocalhost"), "original line preserved: {result}");
        assert!(result.contains("140.82.112.6 api.github.com"), "appended: {result}");
        assert!(result.contains("151.101.1.57 cdn.example.com"), "appended: {result}");
    }

    #[test]
    fn append_hosts_entries_handles_missing_final_newline() {
        // Edge case: existing /etc/hosts missing trailing newline. We
        // must add one before appending or the first new entry gets
        // concatenated to the last existing line.
        let tmp = tempfile_with_content("127.0.0.1\tlocalhost"); // NO trailing newline
        let hosts = vec![HostMapping { name: "example.com".into(), ip: "1.2.3.4".into() }];
        append_hosts_entries(tmp.path(), &hosts).unwrap();
        let result = std::fs::read_to_string(tmp.path()).unwrap();
        assert!(result.contains("127.0.0.1\tlocalhost\n1.2.3.4 example.com"),
            "newline inserted between existing tail and first append: {result}");
    }

    #[test]
    fn append_hosts_entries_empty_is_noop() {
        let tmp = tempfile_with_content("127.0.0.1 localhost\n");
        append_hosts_entries(tmp.path(), &[]).unwrap();
        let result = std::fs::read_to_string(tmp.path()).unwrap();
        assert_eq!(result, "127.0.0.1 localhost\n");
    }

    #[test]
    fn append_hosts_entries_rejects_newline_in_name() {
        let tmp = tempfile_with_content("");
        let hosts = vec![HostMapping {
            name: "evil.com\n0.0.0.0 other.com".into(),
            ip: "1.2.3.4".into(),
        }];
        let err = append_hosts_entries(tmp.path(), &hosts).unwrap_err();
        assert!(err.contains("control char"), "got: {err}");
    }

    #[test]
    fn append_hosts_entries_rejects_nul_in_ip() {
        let tmp = tempfile_with_content("");
        let hosts = vec![HostMapping {
            name: "ok.com".into(),
            ip: "1.2.3.4\0extra".into(),
        }];
        let err = append_hosts_entries(tmp.path(), &hosts).unwrap_err();
        assert!(err.contains("control char"), "got: {err}");
    }

    fn tempfile_with_content(content: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().expect("tempfile");
        f.write_all(content.as_bytes()).expect("write initial content");
        f.flush().expect("flush");
        f
    }

    // NOTE: We don't test the happy path of apply_net_config() end-to-end
    // here — that requires busybox installed + root privileges + eth0
    // present. The test coverage for that lives in firecracker-testbed/
    // (RED-259 preflight proved the mechanism; escape-test extension
    // will exercise the agent's code path). Unit tests here cover the
    // pure functions + error paths reachable in-process.
}
