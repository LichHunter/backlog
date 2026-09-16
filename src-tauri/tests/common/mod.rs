// Each test binary compiles this module; not every binary uses every helper.
#![allow(dead_code)]

//! Shared test helpers for integration tests (hand-rolled tempdir, no dev-deps).

use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

static DIR_COUNTER: AtomicU32 = AtomicU32::new(0);

/// Hand-rolled tempdir (no dev-dep): pid + counter + tag guards collisions.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let n = DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "backlog-server-test-{}-{}-{}",
            tag,
            std::process::id(),
            n
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        TempDir(path)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Sends a raw HTTP/1.1 request (Host defaults to 127.0.0.1 at the call
/// sites) and reads the full response until the server closes the stream.
pub fn http(addr: SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect(addr).expect("connect to spawned server");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .expect("set write timeout");
    stream.write_all(request.as_bytes()).expect("write request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    response
}

pub fn http_get(addr: SocketAddr, path: &str) -> String {
    http(
        addr,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
    )
}

pub fn http_post(addr: SocketAddr, path: &str, body: &str) -> String {
    http(
        addr,
        &format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
}

pub fn http_patch(addr: SocketAddr, path: &str, body: &str) -> String {
    http(
        addr,
        &format!(
            "PATCH {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
}

pub fn http_delete(addr: SocketAddr, path: &str) -> String {
    http(
        addr,
        &format!("DELETE {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
    )
}

pub fn http_options(addr: SocketAddr, path: &str) -> String {
    http(
        addr,
        &format!("OPTIONS {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
    )
}

/// Parses the status code out of the response's first line (0 when absent).
pub fn status_of(raw: &str) -> u16 {
    raw.lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

/// The header block, up to the blank line separating it from the body.
pub fn headers_of(raw: &str) -> &str {
    raw.split_once("\r\n\r\n").map(|(h, _)| h).unwrap_or(raw)
}

/// The body after the blank line separating it from the headers.
pub fn body_of(raw: &str) -> &str {
    raw.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("")
}

/// Parses the response body as JSON (panics with the body on failure).
pub fn json_of(raw: &str) -> serde_json::Value {
    serde_json::from_str(body_of(raw))
        .unwrap_or_else(|e| panic!("response body is not JSON ({e}): {:?}", body_of(raw)))
}
