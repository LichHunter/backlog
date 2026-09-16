//! Shared HTTP handlers for the legacy unscoped routes and the
//! project-scoped surface (`/api/projects/{id}/...`).
//!
//! Every handler is a pure fn over the resolved `&Project` (backlog file,
//! sibling `archive.md`, sibling `backups/`) — the routing layer decides
//! which project that is.

use crate::registry::{Project, DEFAULT_BACKLOG_SKELETON};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use tiny_http::{Header, Response};

pub(super) fn compute_checksum(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("sha256:{}", hex::encode(&hasher.finalize()[..12]))
}

pub(super) fn json_response(body: &str) -> Response<Cursor<Vec<u8>>> {
    json_response_with_status(body, 200)
}

/// JSON response with an explicit status; the body shape matches
/// `json_response` byte-for-byte (same Content-Type, no CORS headers — the
/// webview is same-origin).
pub(super) fn json_response_with_status(body: &str, status: u16) -> Response<Cursor<Vec<u8>>> {
    Response::from_data(body.as_bytes().to_vec())
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
}

fn backlog_path(project: Option<&Project>) -> Option<PathBuf> {
    Some(project?.path.clone())
}

fn archive_path(project: Option<&Project>) -> Option<PathBuf> {
    project?.path.parent().map(|d| d.join("archive.md"))
}

fn backup_dir(project: Option<&Project>) -> Option<PathBuf> {
    project?.path.parent().map(|d| d.join("backups"))
}

pub(super) fn serve_static(frontend_dir: &Path, path: &str) -> Response<Cursor<Vec<u8>>> {
    let file_path = if path == "/" {
        frontend_dir.join("index.html")
    } else {
        frontend_dir.join(path.trim_start_matches('/'))
    };

    match fs::read(&file_path) {
        Ok(content) => {
            let mime = if file_path.extension().map(|e| e == "html").unwrap_or(false) {
                "text/html; charset=utf-8"
            } else if file_path.extension().map(|e| e == "css").unwrap_or(false) {
                "text/css"
            } else if file_path.extension().map(|e| e == "js").unwrap_or(false) {
                "application/javascript"
            } else {
                "application/octet-stream"
            };
            Response::from_data(content)
                .with_header(Header::from_bytes("Content-Type", mime).unwrap())
        }
        Err(_) => {
            // Fallback to index.html for SPA routing
            if let Ok(content) = fs::read(frontend_dir.join("index.html")) {
                Response::from_data(content)
                    .with_header(Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap())
            } else {
                Response::from_string("Not Found").with_status_code(404)
            }
        }
    }
}

pub(super) fn handle_health(project: Option<&Project>) -> Response<Cursor<Vec<u8>>> {
    let (master_path, master_size) = project
        .and_then(|p| {
            fs::metadata(&p.path)
                .ok()
                .map(|m| (p.path.to_string_lossy().to_string(), m.len()))
        })
        .unwrap_or_default();

    let backups_path = backup_dir(project)
        .map(|d| d.to_string_lossy().to_string())
        .unwrap_or_default();

    let (archive_path, archive_exists, archive_size) = archive_path(project)
        .map(|p| {
            let exists = p.exists();
            let size = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            (p.to_string_lossy().to_string(), exists, size)
        })
        .unwrap_or_default();

    let body = serde_json::json!({
        "ok": project.is_some(),
        "masterPath": master_path,
        "masterSize": master_size,
        "backupsPath": backups_path,
        "archiveExists": archive_exists,
        "archivePath": archive_path,
        "archiveSize": archive_size
    });

    json_response(&body.to_string())
}

pub(super) fn handle_load_backlog(project: Option<&Project>) -> Response<Cursor<Vec<u8>>> {
    let Some(path) = backlog_path(project) else {
        return json_response(r#"{"error": "Data directory not set"}"#);
    };

    if !path.exists() {
        if let Err(e) = fs::write(&path, DEFAULT_BACKLOG_SKELETON) {
            return json_response(&format!(r#"{{"error": "Failed to create: {}"}}"#, e));
        }
    }

    match fs::read_to_string(&path) {
        Ok(content) => {
            let checksum = compute_checksum(&content);
            let body = serde_json::json!({ "content": content, "checksum": checksum });
            json_response(&body.to_string())
        }
        Err(e) => json_response(&format!(r#"{{"error": "Failed to load: {}"}}"#, e)),
    }
}

pub(super) fn handle_save_backlog(
    project: Option<&Project>,
    body: &str,
) -> Response<Cursor<Vec<u8>>> {
    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return json_response(r#"{"error": "Invalid JSON"}"#),
    };

    let content = json["content"].as_str().unwrap_or("");

    let Some(path) = backlog_path(project) else {
        return json_response(r#"{"error": "Data directory not set"}"#);
    };

    let Some(backup_dir) = backup_dir(project) else {
        return json_response(r#"{"error": "Data directory not set"}"#);
    };

    if !backup_dir.exists() {
        let _ = fs::create_dir_all(&backup_dir);
    }

    if path.exists() {
        let now = Utc::now();
        let backup_name = format!("backlog_{}.md", now.format("%Y%m%d_%H%M%S"));
        let _ = fs::copy(&path, backup_dir.join(&backup_name));
    }

    match fs::write(&path, content) {
        Ok(()) => {
            let checksum = compute_checksum(content);
            let saved = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
            let body = serde_json::json!({ "ok": true, "checksum": checksum, "saved": saved });
            json_response(&body.to_string())
        }
        Err(e) => json_response(&format!(r#"{{"error": "Failed to save: {}"}}"#, e)),
    }
}

pub(super) fn handle_list_backups(project: Option<&Project>) -> Response<Cursor<Vec<u8>>> {
    let Some(backup_dir) = backup_dir(project) else {
        return json_response(r#"{"backups": []}"#);
    };

    let mut backups = Vec::new();
    if let Ok(entries) = fs::read_dir(&backup_dir) {
        for entry in entries.flatten() {
            if let Some(name) = entry.file_name().to_str() {
                if name.starts_with("backlog_") && name.ends_with(".md") {
                    backups.push(name.to_string());
                }
            }
        }
    }
    backups.sort();
    backups.reverse();

    let body = serde_json::json!({ "backups": backups });
    json_response(&body.to_string())
}

pub(super) fn handle_restore_backup(
    project: Option<&Project>,
    body: &str,
) -> Response<Cursor<Vec<u8>>> {
    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return json_response(r#"{"ok": false, "error": "Invalid JSON"}"#),
    };

    let name = json["name"].as_str().unwrap_or("");

    let Some(backup_dir) = backup_dir(project) else {
        return json_response(r#"{"ok": false, "error": "No backup dir"}"#);
    };
    let Some(backlog_path) = backlog_path(project) else {
        return json_response(r#"{"ok": false, "error": "No data dir"}"#);
    };

    let backup_path = backup_dir.join(name);
    if !backup_path.exists() {
        return json_response(r#"{"ok": false, "error": "Backup not found"}"#);
    }

    match fs::read_to_string(&backup_path) {
        Ok(content) => {
            if let Err(e) = fs::write(&backlog_path, &content) {
                return json_response(&format!(r#"{{"ok": false, "error": "Restore failed: {}"}}"#, e));
            }
            let checksum = compute_checksum(&content);
            let body = serde_json::json!({"ok": true, "content": content, "checksum": checksum});
            json_response(&body.to_string())
        }
        Err(e) => json_response(&format!(r#"{{"ok": false, "error": "Read failed: {}"}}"#, e)),
    }
}

pub(super) fn handle_load_archive(project: Option<&Project>) -> Response<Cursor<Vec<u8>>> {
    let Some(path) = archive_path(project) else {
        return json_response(r#"{"error": "Data directory not set"}"#);
    };

    if !path.exists() {
        return json_response(r#"{"content": "", "checksum": "", "exists": false}"#);
    }

    match fs::read_to_string(&path) {
        Ok(content) => {
            let checksum = compute_checksum(&content);
            let body = serde_json::json!({ "content": content, "checksum": checksum, "exists": true });
            json_response(&body.to_string())
        }
        Err(e) => json_response(&format!(r#"{{"error": "Failed to load: {}"}}"#, e)),
    }
}

pub(super) fn handle_save_archive(
    project: Option<&Project>,
    body: &str,
) -> Response<Cursor<Vec<u8>>> {
    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return json_response(r#"{"ok": false}"#),
    };

    let backlog = json["backlog"].as_str().unwrap_or("");
    let archive = json["archive"].as_str().unwrap_or("");

    let Some(backlog_path) = backlog_path(project) else {
        return json_response(r#"{"ok": false}"#);
    };
    let Some(archive_path) = archive_path(project) else {
        return json_response(r#"{"ok": false}"#);
    };

    if let Err(e) = fs::write(&backlog_path, backlog) {
        return json_response(&format!(r#"{{"ok": false, "error": "{}"}}"#, e));
    }
    if let Err(e) = fs::write(&archive_path, archive) {
        return json_response(&format!(r#"{{"ok": false, "error": "{}"}}"#, e));
    }

    json_response(r#"{"ok": true}"#)
}
