//! Per-OS daemon endpoint naming: Unix socket files under
//! `<tmpdir>/prime-agent-<uid>/`; Windows named pipes in the `\\.\\pipe\\`
//! namespace (fixed daemon pipe, hashed worker pipes) - the TS product's
//! exact split.
use std::path::{Path, PathBuf};

use crate::paths::hash_key;

/// Default directory holding daemon socket files (Unix).
#[cfg(unix)]
pub fn socket_dir() -> PathBuf {
    let uid = pa_core::platform::process::current_user_id();
    let tmp = std::env::var_os("TMPDIR").map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
    tmp.join(format!("prime-agent-{uid}"))
}

/// The socket-dir half of a discovery state root on Windows: TS computes
/// `<tmpdir>/prime-agent-user` so `DaemonStateRoot` keeps one shape.
#[cfg(not(unix))]
#[must_use]
pub fn socket_dir() -> PathBuf {
    std::env::temp_dir().join("prime-agent-user")
}

/// Default supervisor endpoint: `daemon.sock` in the socket dir (Unix) or
/// the fixed daemon pipe name (Windows).
#[cfg(unix)]
#[must_use]
pub fn default_daemon_socket_path() -> PathBuf {
    socket_dir().join("daemon.sock")
}

#[cfg(not(unix))]
#[must_use]
pub fn default_daemon_socket_path() -> PathBuf {
    PathBuf::from(r"\\.\pipe\prime-agent-daemon")
}

/// Worker endpoint next to the supervisor's: hashed supervisor key plus the
/// worker id prefix (TS `workerSocketPath` layout `worker-${key}-${id}.sock`).
/// The key is 6 hex chars, one short of the TS 7: TS binds through libuv,
/// which passes the exact sockaddr length and tolerates a 104-char path under
/// the stock macOS per-user TMPDIR, while Rust std requires the path to fit
/// with a NUL terminator (SUN_LEN), capping it at 103 chars. With the 12-char
/// key the path overruns even the 107-byte Linux limit.
#[cfg(unix)]
#[must_use]
pub fn worker_socket_path(supervisor_socket_path: &Path, worker_id: &str) -> PathBuf {
    let key = hash_key(&supervisor_socket_path.to_string_lossy(), 6);
    socket_dir().join(format!(
        "worker-{key}-{}.sock",
        &worker_id[..12.min(worker_id.len())]
    ))
}

#[cfg(not(unix))]
#[must_use]
pub fn worker_socket_path(supervisor_socket_path: &Path, worker_id: &str) -> PathBuf {
    let key = hash_key(&supervisor_socket_path.to_string_lossy(), 6);
    PathBuf::from(format!(
        r"\\.\pipe\prime-agent-worker-{key}-{}",
        &worker_id[..12.min(worker_id.len())]
    ))
}

// Socket-filesystem identity is the shared platform contract
// `pa_types::platform::socket_identity`: the same helper serves stale-file
// cleanup here and direct-transport ticket validation in the clients.

pub use pa_types::daemon::SocketIdentity;
pub use pa_types::platform::socket_identity;
#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn default_socket_uses_the_same_real_uid_as_the_typescript_daemon() {
        let output = std::process::Command::new("id")
            .arg("-ru")
            .output()
            .unwrap();
        assert!(output.status.success());
        let uid = String::from_utf8(output.stdout).unwrap();
        let tmp = std::env::var_os("TMPDIR").map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
        assert_eq!(
            socket_dir(),
            tmp.join(format!("prime-agent-{}", uid.trim()))
        );
    }

    #[test]
    fn worker_socket_names_are_deterministic() {
        let supervisor = Path::new("/tmp/prime-agent-1/daemon.sock");
        let a = worker_socket_path(supervisor, "0123456789abcdef");
        let b = worker_socket_path(supervisor, "fedcba9876543210");
        assert_ne!(a, b);
        // Only the first 12 id characters key the name.
        assert_eq!(a, worker_socket_path(supervisor, "0123456789abffff"));
        #[cfg(unix)]
        assert!(a.starts_with(socket_dir()));
    }

    /// The Windows endpoint names (TS win32 arms): the fixed daemon pipe
    /// name and the hashed worker pipe name in the `\\.\\pipe\\` namespace.
    /// The worker name rides a per-user TMPDIR prefix that reaches 72 chars
    /// on the stock macOS layout (`/var/folders/.../T/prime-agent-<uid>/`).
    /// macOS `bind` requires the whole path to fit with a NUL terminator
    /// (103 chars), so the name must stay within 31. The pre-fix name used a
    /// 12-char supervisor hash (37 chars) and the worker could not bind,
    /// hanging every bb launch on the daemon create.
    #[test]
    #[cfg(unix)]
    fn worker_socket_name_fits_the_unix_path_limit() {
        let supervisor = Path::new("/tmp/prime-agent-1/daemon.sock");
        let name = worker_socket_path(supervisor, "abcdef123456")
            .file_name()
            .and_then(|name| name.to_str())
            .expect("worker socket name")
            .to_string();
        assert!(
            name.len() <= 31,
            "worker socket name must fit 72-char TMPDIR prefix + 103-char unix limit, got {name}"
        );
        let key = name
            .strip_prefix("worker-")
            .and_then(|rest| rest.split('-').next())
            .expect("worker socket key");
        assert_eq!(key.len(), 6, "the supervisor hash stays 6 chars");
        assert!(name.ends_with("-abcdef123456.sock"));
    }

    #[test]
    #[cfg(windows)]
    fn windows_endpoints_are_the_ts_pipe_names() {
        assert_eq!(
            default_daemon_socket_path(),
            PathBuf::from(r"\\.\pipe\prime-agent-daemon")
        );
        let supervisor = Path::new(r"\\.\pipe\prime-agent-daemon");
        let a = worker_socket_path(supervisor, "0123456789abcdef");
        let rendered = a.to_string_lossy();
        assert!(
            rendered.starts_with(r"\\.\pipe\prime-agent-worker-"),
            "the worker pipe namespace: {rendered}"
        );
        assert!(
            rendered.ends_with("-0123456789ab"),
            "the 12-char id suffix: {rendered}"
        );
    }
}
