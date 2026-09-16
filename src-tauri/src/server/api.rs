//! Project-scoped REST surface: `/api/projects` CRUD, the per-project
//! document routes (delegating to the SAME handler fns the legacy aliases
//! use), `/api/pick-folder`, and the `/api/config` tombstone.

use crate::registry::{Registry, RegistryError};
use crate::server::handlers::{
    compute_checksum, handle_health, handle_list_backups, handle_load_archive, handle_load_backlog,
    handle_restore_backup, handle_save_archive, handle_save_backlog, json_response_with_status,
};
use serde_json::json;
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::time::UNIX_EPOCH;
use tiny_http::{Method, Request, Response};

/// Project ids are opaque; the shape check runs BEFORE any registry or
/// filesystem access so traversal payloads never reach the disk.
/// Equivalent of the regex `^[A-Za-z0-9_-]{1,64}$`.
fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn error_response(status: u16, message: &str) -> Response<Cursor<Vec<u8>>> {
    json_response_with_status(&json!({ "error": message }).to_string(), status)
}

fn unknown_project() -> Response<Cursor<Vec<u8>>> {
    error_response(404, "unknown project")
}

/// Routes the project-scoped surface; `None` means the request belongs to
/// the legacy/static routing in the parent module.
pub(super) fn route(
    registry: &Registry,
    method: &Method,
    path: &str,
    query: &str,
    request: &mut Request,
) -> Option<Response<Cursor<Vec<u8>>>> {
    if path == "/api/config" && method == &Method::Post {
        return Some(error_response(410, "deprecated: use /api/projects"));
    }
    if path == "/api/pick-folder" && method == &Method::Post {
        return Some(handle_pick_folder());
    }
    if path != "/api/projects" && !path.starts_with("/api/projects/") {
        return None;
    }
    Some(route_projects(registry, method, path, query, request))
}

fn route_projects(
    registry: &Registry,
    method: &Method,
    path: &str,
    query: &str,
    request: &mut Request,
) -> Response<Cursor<Vec<u8>>> {
    if path == "/api/projects" {
        return match method {
            Method::Get => handle_list_projects(registry),
            Method::Post => handle_register(registry, &super::read_body(request)),
            _ => error_response(404, "Not found"),
        };
    }

    let rest = &path["/api/projects/".len()..];
    let (id, action) = match rest.split_once('/') {
        Some((id, action)) => (id, Some(action)),
        None => (rest, None),
    };
    if !valid_id(id) {
        return unknown_project();
    }
    let Some(project) = registry.get(id) else {
        return unknown_project();
    };

    match (method, action) {
        (Method::Patch, None) => {
            handle_rename(registry, &project.id, &super::read_body(request))
        }
        (Method::Delete, None) => handle_remove(registry, &project.id, query),
        (Method::Get, Some("backlog")) => handle_load_backlog(Some(&project)),
        (Method::Post, Some("backlog")) => {
            handle_save_backlog(Some(&project), &super::read_body(request))
        }
        (Method::Get, Some("archive")) => handle_load_archive(Some(&project)),
        (Method::Post, Some("archive")) | (Method::Post, Some("archive/restore")) => {
            handle_save_archive(Some(&project), &super::read_body(request))
        }
        (Method::Get, Some("backups")) => handle_list_backups(Some(&project)),
        (Method::Post, Some("backups/restore")) => {
            handle_restore_backup(Some(&project), &super::read_body(request))
        }
        (Method::Get, Some("health")) => handle_health(Some(&project)),
        _ => error_response(404, "Not found"),
    }
}

fn handle_list_projects(registry: &Registry) -> Response<Cursor<Vec<u8>>> {
    let default_id = registry.default().map(|project| project.id.clone());
    let projects: Vec<_> = registry
        .list()
        .into_iter()
        .map(|project| {
            let (checksum, saved_at_ms) = match fs::read_to_string(&project.path) {
                Ok(content) => (
                    json!(compute_checksum(&content)),
                    mtime_ms(&project.path).map(|ms| json!(ms)).unwrap_or(json!(null)),
                ),
                Err(_) => (json!(null), json!(null)),
            };
            json!({
                "id": project.id,
                "name": project.name,
                "path": project.path.to_string_lossy(),
                "default": default_id.as_deref() == Some(project.id.as_str()),
                "exists": project.path.is_file(),
                "checksum": checksum,
                "savedAtMs": saved_at_ms,
            })
        })
        .collect();
    json_response_with_status(&json!({ "projects": projects }).to_string(), 200)
}

fn mtime_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

fn handle_register(registry: &Registry, body: &str) -> Response<Cursor<Vec<u8>>> {
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return error_response(400, "invalid JSON"),
    };
    let Some(path) = payload["path"].as_str() else {
        return error_response(400, "missing path");
    };
    let name = payload["name"].as_str().map(str::to_string);
    match registry.register(path, name) {
        Ok(project) => {
            let body = json!({
                "project": {
                    "id": project.id,
                    "name": project.name,
                    "path": project.path.to_string_lossy(),
                }
            });
            json_response_with_status(&body.to_string(), 201)
        }
        Err(e) => error_response(400, &e.to_string()),
    }
}

fn handle_rename(registry: &Registry, id: &str, body: &str) -> Response<Cursor<Vec<u8>>> {
    let payload: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return error_response(400, "invalid JSON"),
    };
    let Some(name) = payload["name"].as_str() else {
        return error_response(400, "missing name");
    };
    match registry.rename(id, name) {
        Ok(()) => json_response_with_status(r#"{"ok":true}"#, 200),
        Err(RegistryError::UnknownProject) => unknown_project(),
        Err(e) => error_response(400, &e.to_string()),
    }
}

fn handle_remove(registry: &Registry, id: &str, query: &str) -> Response<Cursor<Vec<u8>>> {
    let delete_files = query.split('&').any(|pair| pair == "delete_files=true");
    match registry.remove(id, delete_files) {
        Ok(_) => {
            let default_id = registry
                .default()
                .map(|p| p.id.clone())
                .unwrap_or_default();
            json_response_with_status(&json!({ "ok": true, "defaultProjectId": default_id }).to_string(), 200)
        }
        Err(RegistryError::UnknownProject) => unknown_project(),
        Err(RegistryError::LastProject) => {
            error_response(400, "cannot remove the last remaining project")
        }
        Err(e) => error_response(400, &e.to_string()),
    }
}

#[cfg(desktop)]
fn handle_pick_folder() -> Response<Cursor<Vec<u8>>> {
    match crate::app_handle() {
        Some(app) => {
            use tauri_plugin_dialog::DialogExt;
            // blocking_pick_folder dispatches to the main thread internally;
            // calling it from the server thread keeps the webview loop live.
            let picked = app
                .dialog()
                .file()
                .blocking_pick_folder()
                .and_then(|folder| folder.into_path().ok())
                .map(|path| path.to_string_lossy().to_string());
            json_response_with_status(&json!({ "path": picked }).to_string(), 200)
        }
        None => error_response(501, "picker unavailable"),
    }
}

#[cfg(not(desktop))]
fn handle_pick_folder() -> Response<Cursor<Vec<u8>>> {
    error_response(501, "picker unavailable")
}
