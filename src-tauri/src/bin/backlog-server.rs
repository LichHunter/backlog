//! Standalone `backlog-server`: the same HTTP harness as the desktop app,
//! minus the webview. Serves the registry's default project for
//! browser/curl QA.

use std::path::PathBuf;
use std::process::exit;
use std::sync::Arc;

use backlog_app_lib::registry::Registry;
use backlog_app_lib::{bootstrap_registry, default_data_root, server};

const USAGE: &str = "Usage: backlog-server [OPTIONS]

Options:
  --port <PORT>           TCP port to bind on 127.0.0.1 (default: 1421)
  --frontend <DIR>        Directory holding index.html (default: ./src)
  --projects-file <PATH>  Registry projects.json path
                          (default: <BACKLOG_DATA_HOME or local data dir>/backlog-app/projects.json)
  --help                  Print this message";

fn main() {
    env_logger::init();

    let mut port: u16 = 1421;
    let mut frontend = PathBuf::from("./src");
    let mut projects_file: Option<PathBuf> = None;

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!("{USAGE}");
                exit(0);
            }
            "--port" => {
                let Some(value) = args.next() else {
                    eprintln!("backlog-server: --port requires a value");
                    exit(2);
                };
                match value.parse() {
                    Ok(parsed) => port = parsed,
                    Err(_) => {
                        eprintln!("backlog-server: invalid port {:?}", value);
                        exit(2);
                    }
                }
            }
            "--frontend" => {
                let Some(value) = args.next() else {
                    eprintln!("backlog-server: --frontend requires a value");
                    exit(2);
                };
                frontend = PathBuf::from(value);
            }
            "--projects-file" => {
                let Some(value) = args.next() else {
                    eprintln!("backlog-server: --projects-file requires a value");
                    exit(2);
                };
                projects_file = Some(PathBuf::from(value));
            }
            other => {
                eprintln!("backlog-server: unknown argument {:?}", other);
                eprintln!("{USAGE}");
                exit(2);
            }
        }
    }

    if !frontend.is_dir() {
        eprintln!(
            "backlog-server: frontend directory {:?} does not exist",
            frontend
        );
        exit(2);
    }

    let projects_file = projects_file.unwrap_or_else(|| default_data_root().join("projects.json"));
    let root = projects_file
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    if let Err(e) = std::fs::create_dir_all(&root) {
        eprintln!("backlog-server: cannot create data root {:?}: {}", root, e);
        exit(1);
    }

    let registry = Arc::new(Registry::with_path(projects_file));
    registry.load_or_default();
    // No legacy dirs for the bin: it may run from anywhere (repo checkout,
    // PATH, CI) and must never scan whatever happens to sit next to its
    // binary — only the explicit data root (root + root/data) is scanned.
    bootstrap_registry(&registry, &root, &[]);

    let (addr, accept_loop) = match server::bind_and_spawn(registry, frontend, Some(port)) {
        Ok(bound) => bound,
        Err(e) => {
            eprintln!(
                "backlog-server: failed to bind 127.0.0.1:{}: {}",
                port, e
            );
            exit(1);
        }
    };

    println!("backlog-server listening on http://{}", addr);

    if accept_loop.join().is_err() {
        eprintln!("backlog-server: accept loop terminated unexpectedly");
        exit(1);
    }
}
