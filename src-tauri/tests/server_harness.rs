//! Integration tests for the server harness (todo 3).
//!
//! Characterization net: the legacy unscoped routes keep serving the
//! REGISTRY's default project exactly like the old AppState::data_dir
//! behavior. Each test binds on an OS-assigned port; accept-loop threads
//! intentionally leak for the rest of the test process lifetime (cargo test
//! exits the process and reaps them — the legacy loop has no shutdown path).

mod common;

use backlog_app_lib::registry::Registry;
use backlog_app_lib::server::bind_and_spawn;
use common::TempDir;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::time::Duration;

fn http(addr: SocketAddr, request: &str) -> String {
    let mut stream = TcpStream::connect(addr).expect("connect to spawned server");
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");
    stream.write_all(request.as_bytes()).expect("write request");
    let mut response = String::new();
    stream.read_to_string(&mut response).expect("read response");
    response
}

fn http_get(addr: SocketAddr, path: &str) -> String {
    http(
        addr,
        &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"),
    )
}

fn http_post(addr: SocketAddr, path: &str, body: &str) -> String {
    http(
        addr,
        &format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    )
}

fn spawn_with_default_project(tmp: &TempDir, port_hint: Option<u16>) -> (SocketAddr, std::thread::JoinHandle<()>) {
    let registry = Arc::new(Registry::with_path(tmp.path().join("projects.json")));
    registry
        .register(
            tmp.path().join("data").join("backlog.md").to_str().unwrap(),
            Some("Backlog".into()),
        )
        .expect("register default project");
    bind_and_spawn(registry, tmp.path().join("frontend"), port_hint).expect("bind_and_spawn")
}

mod server_harness {
    use super::*;

    #[test]
    fn legacy_routes_serve_registry_default_project_end_to_end() {
        // Given: a harness with one registered (default) project
        let tmp = TempDir::new("legacy");
        let (addr, _accept_loop) = spawn_with_default_project(&tmp, None);

        // Then: GET /api/health answers 200 with ok:true (registry default exists)
        let health = http_get(addr, "/api/health");
        assert!(health.starts_with("HTTP/1.1 200"), "health status line: {health}");
        assert!(health.contains(r#""ok":true"#), "health body: {health}");

        // And: GET /api/backlog serves the seeded skeleton content
        let load = http_get(addr, "/api/backlog");
        assert!(load.starts_with("HTTP/1.1 200"), "load status line: {load}");
        assert!(load.contains(r#""content""#), "load body: {load}");
        assert!(load.contains("# Backlog"), "skeleton expected: {load}");

        // And: create-on-first-load is preserved when the file disappears
        let backlog_file = tmp.path().join("data").join("backlog.md");
        std::fs::remove_file(&backlog_file).expect("remove seeded file");
        let recreated = http_get(addr, "/api/backlog");
        assert!(recreated.contains("# Backlog"), "recreated skeleton: {recreated}");
        assert!(backlog_file.exists(), "file recreated on first load");

        // And: POST /api/backlog saves, then GET round-trips the content
        let save = http_post(addr, "/api/backlog", r##"{"content":"# hi"}"##);
        assert!(save.starts_with("HTTP/1.1 200"), "save status line: {save}");
        assert!(save.contains(r#""ok":true"#), "save body: {save}");
        let reload = http_get(addr, "/api/backlog");
        assert!(reload.contains("# hi"), "reload body: {reload}");
    }

    #[test]
    fn port_hint_zero_returns_os_assigned_port() {
        // Given: a harness started with the port hint Some(0)
        let tmp = TempDir::new("hintzero");

        // When: binding
        let (addr, _accept_loop) = spawn_with_default_project(&tmp, Some(0));

        // Then: the returned addr carries a concrete OS-assigned port
        assert_ne!(addr.port(), 0);
    }

    #[test]
    fn fixed_port_collision_surfaces_as_err_not_silent_death() {
        // Given: a port already occupied by another listener
        let squatter = TcpListener::bind("127.0.0.1:0").expect("bind squatter");
        let taken_port = squatter.local_addr().expect("squatter addr").port();
        let tmp = TempDir::new("collision");

        // When: binding a harness with that exact port hint
        let registry = Arc::new(Registry::with_path(tmp.path().join("projects.json")));
        registry
            .register(tmp.path().join("data").join("backlog.md").to_str().unwrap(), None)
            .expect("register project");
        let result = bind_and_spawn(registry, tmp.path().join("frontend"), Some(taken_port));

        // Then: the collision is surfaced as Err (no silent death, no wildcard fallback)
        assert!(result.is_err(), "hinted-port collision must return Err");
    }
}
