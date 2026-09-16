//! HTTP harness: bind-with-retry, readiness-by-return, and the single
//! routing point for all legacy API routes.
//!
//! `bind_and_spawn` returns `Ok` only after the socket is bound, so callers
//! need no sleep-and-hope wait; the accept loop then runs forever in the
//! spawned thread. Bind failures are surfaced as `Err` — silent death is
//! forbidden.

use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use tiny_http::{Header, ListenAddr, Method, Request, Response, Server};

use crate::registry::Registry;

mod handlers;
use handlers::{
    handle_health, handle_list_backups, handle_load_archive, handle_load_backlog,
    handle_restore_backup, handle_save_archive, handle_save_backlog, json_response, serve_static,
};

/// OS-assigned (port 0) binds are attempted this many times before giving up.
const BIND_ATTEMPTS: usize = 5;

/// Binds 127.0.0.1 and spawns the accept loop.
///
/// A concrete hinted port is attempted exactly once — retrying it or falling
/// back to a random port would hide the collision from the caller. With no
/// hint (or hint 0) the OS assigns the port and a failed bind is retried
/// before the last error is returned.
pub fn bind_and_spawn(
    registry: Arc<Registry>,
    frontend_dir: PathBuf,
    port_hint: Option<u16>,
) -> io::Result<(SocketAddr, thread::JoinHandle<()>)> {
    let (server, addr) = bind_with_retry(port_hint)?;
    log::info!("HTTP server running on http://{}", addr);
    let handle = thread::spawn(move || serve_requests(server, registry, frontend_dir));
    Ok((addr, handle))
}

fn bind_with_retry(port_hint: Option<u16>) -> io::Result<(Server, SocketAddr)> {
    let fixed_port = port_hint.filter(|p| *p != 0);
    let attempts = if fixed_port.is_some() { 1 } else { BIND_ATTEMPTS };

    let mut last_err = None;
    for _ in 0..attempts {
        match bind(fixed_port.unwrap_or(0)) {
            Ok(bound) => return Ok(bound),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| io::Error::new(io::ErrorKind::AddrInUse, "bind failed")))
}

fn bind(port: u16) -> io::Result<(Server, SocketAddr)> {
    let server = Server::http(("127.0.0.1", port)).map_err(io::Error::other)?;
    let addr = match server.server_addr() {
        ListenAddr::IP(addr) => addr,
        _ => return Err(io::Error::other("unix listen addr from a tcp bind")),
    };
    Ok((server, addr))
}

fn read_body(request: &mut Request) -> String {
    let mut body = String::new();
    let _ = request.as_reader().read_to_string(&mut body);
    body
}

fn serve_requests(server: Server, registry: Arc<Registry>, frontend_dir: PathBuf) {
    for mut request in server.incoming_requests() {
        let url = request.url().to_string();
        let method = request.method().clone();

        // CORS preflight
        if method == Method::Options {
            let response = Response::empty(200)
                .with_header(Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap())
                .with_header(Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap())
                .with_header(Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap());
            let _ = request.respond(response);
            continue;
        }

        let project = registry.default();
        let response = match (method, url.as_str()) {
            (Method::Get, "/api/health") => handle_health(project.as_deref()),
            (Method::Get, "/api/backlog") => handle_load_backlog(project.as_deref()),
            (Method::Post, "/api/backlog") => {
                let body = read_body(&mut request);
                handle_save_backlog(project.as_deref(), &body)
            }
            (Method::Get, "/api/backups") => handle_list_backups(project.as_deref()),
            (Method::Post, "/api/backups/restore") => {
                let body = read_body(&mut request);
                handle_restore_backup(project.as_deref(), &body)
            }
            (Method::Get, "/api/archive") => handle_load_archive(project.as_deref()),
            (Method::Post, "/api/archive") | (Method::Post, "/api/archive/restore") => {
                let body = read_body(&mut request);
                handle_save_archive(project.as_deref(), &body)
            }
            (Method::Get, path) => serve_static(&frontend_dir, path),
            _ => json_response(r#"{"error": "Not found"}"#),
        };

        let _ = request.respond(response);
    }
}
