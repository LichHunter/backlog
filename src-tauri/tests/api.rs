//! Integration tests for the project-scoped REST surface (todo 4).
//!
//! Tests live inside `mod api` so `cargo test api` matches every test name.
//! Every test binds its own server on an OS-assigned port with a scratch
//! registry; accept-loop threads intentionally leak for the process
//! lifetime (the legacy loop has no shutdown path).

mod common;

use backlog_app_lib::registry::Registry;
use backlog_app_lib::server::bind_and_spawn;
use common::{
    http, http_delete, http_get, http_options, http_patch, http_post, json_of, status_of,
    TempDir,
};
use std::net::SocketAddr;
use std::sync::Arc;

fn spawn(tmp: &TempDir) -> SocketAddr {
    let registry = Arc::new(Registry::with_path(tmp.path().join("projects.json")));
    std::fs::write(tmp.path().join("frontend-index.html"), b"<html></html>")
        .expect("seed frontend marker");
    let frontend = tmp.path().join("frontend");
    std::fs::create_dir_all(&frontend).expect("create frontend dir");
    std::fs::write(frontend.join("index.html"), b"<html>app</html>").expect("seed index.html");
    let (addr, _accept_loop) =
        bind_and_spawn(registry, frontend, None).expect("bind_and_spawn");
    addr
}

/// Registers a project through the REST surface and returns its id.
fn register_project(addr: SocketAddr, file_path: &str, name: Option<&str>) -> String {
    let body = match name {
        Some(name) => format!(r#"{{"path":"{file_path}","name":"{name}"}}"#),
        None => format!(r#"{{"path":"{file_path}"}}"#),
    };
    let raw = http_post(addr, "/api/projects", &body);
    assert_eq!(status_of(&raw), 201, "register response: {raw}");
    let id = json_of(&raw)["project"]["id"]
        .as_str()
        .expect("project id in register response")
        .to_string();
    assert!(id.starts_with("p_"), "id shape: {id}");
    id
}

mod api {
    use super::*;
    use common::{body_of, headers_of};

    fn tmp_project_path(tmp: &TempDir, tag: &str) -> String {
        tmp.path().join(tag).join("backlog.md").to_string_lossy().to_string()
    }

    #[test]
    fn two_projects_keep_independent_backlogs() {
        // Given: a server with two registered projects, A first (default)
        let tmp = TempDir::new("api-indep");
        let addr = spawn(&tmp);
        let a = register_project(addr, &tmp_project_path(&tmp, "a"), None);
        let b = register_project(addr, &tmp_project_path(&tmp, "b"), None);

        // When: content is saved to project A only
        let save = http_post(
            addr,
            &format!("/api/projects/{a}/backlog"),
            r##"{"content":"# only A has this"}"##,
        );
        assert_eq!(status_of(&save), 200, "scoped save: {save}");
        assert_eq!(json_of(&save)["ok"], serde_json::json!(true));

        // Then: A serves it, B does not
        let load_a = json_of(&http_get(addr, &format!("/api/projects/{a}/backlog")));
        let load_b = json_of(&http_get(addr, &format!("/api/projects/{b}/backlog")));
        assert_eq!(load_a["content"], serde_json::json!("# only A has this"));
        assert_ne!(load_b["content"], serde_json::json!("# only A has this"));

        // And: the legacy unscoped route serves the default project (A)
        let legacy = json_of(&http_get(addr, "/api/backlog"));
        assert_eq!(legacy["content"], load_a["content"]);
        assert_eq!(legacy["checksum"], load_a["checksum"]);
    }

    #[test]
    fn legacy_routes_match_scoped_default_project() {
        let tmp = TempDir::new("api-parity");
        let addr = spawn(&tmp);
        let a = register_project(addr, &tmp_project_path(&tmp, "a"), None);
        let _b = register_project(addr, &tmp_project_path(&tmp, "b"), None);
        let scoped = |action: &str| format!("/api/projects/{a}/{action}");

        // Seed distinct content + at least one backup on the default project
        assert_eq!(
            status_of(&http_post(addr, &scoped("backlog"), r#"{"content":"v1"}"#)),
            200
        );
        assert_eq!(
            status_of(&http_post(addr, "/api/backlog", r#"{"content":"v2"}"#)),
            200
        );

        // health: full JSON parity
        let legacy_health = json_of(&http_get(addr, "/api/health"));
        let scoped_health = json_of(&http_get(addr, &scoped("health")));
        assert_eq!(legacy_health, scoped_health);
        assert_eq!(legacy_health["ok"], serde_json::json!(true));

        // backlog GET parity
        assert_eq!(
            json_of(&http_get(addr, "/api/backlog")),
            json_of(&http_get(addr, &scoped("backlog")))
        );

        // backlog POST parity (ok + checksum; "saved" timestamp is dynamic)
        let legacy_save = json_of(&http_post(addr, "/api/backlog", r#"{"content":"parity"}"#));
        let scoped_save =
            json_of(&http_post(addr, &scoped("backlog"), r#"{"content":"parity"}"#));
        assert_eq!(legacy_save["ok"], scoped_save["ok"]);
        assert_eq!(legacy_save["checksum"], scoped_save["checksum"]);

        // backups GET parity
        let legacy_backups = json_of(&http_get(addr, "/api/backups"));
        let scoped_backups = json_of(&http_get(addr, &scoped("backups")));
        assert_eq!(legacy_backups, scoped_backups);
        let backup_name = scoped_backups["backups"][0]
            .as_str()
            .expect("at least one backup exists")
            .to_string();

        // backups/restore parity (same backup restored via both surfaces)
        let legacy_restore = json_of(&http_post(
            addr,
            "/api/backups/restore",
            &format!(r#"{{"name":"{backup_name}"}}"#),
        ));
        let scoped_restore = json_of(&http_post(
            addr,
            &scoped("backups/restore"),
            &format!(r#"{{"name":"{backup_name}"}}"#),
        ));
        assert_eq!(legacy_restore, scoped_restore);
        assert_eq!(legacy_restore["ok"], serde_json::json!(true));

        // archive POST parity (identical bodies through both surfaces)
        let legacy_arch = json_of(&http_post(
            addr,
            "/api/archive",
            r#"{"backlog":"bl","archive":"ar"}"#,
        ));
        let scoped_arch = json_of(&http_post(
            addr,
            &scoped("archive"),
            r#"{"backlog":"bl","archive":"ar"}"#,
        ));
        assert_eq!(legacy_arch, scoped_arch);
        assert_eq!(legacy_arch["ok"], serde_json::json!(true));

        // archive GET parity
        assert_eq!(
            json_of(&http_get(addr, "/api/archive")),
            json_of(&http_get(addr, &scoped("archive")))
        );

        // archive/restore parity (same save-both handler as /api/archive)
        let legacy_res = json_of(&http_post(
            addr,
            "/api/archive/restore",
            r#"{"backlog":"bl2","archive":"ar2"}"#,
        ));
        let scoped_res = json_of(&http_post(
            addr,
            &scoped("archive/restore"),
            r#"{"backlog":"bl2","archive":"ar2"}"#,
        ));
        assert_eq!(legacy_res, scoped_res);
        assert_eq!(json_of(&http_get(addr, &scoped("archive")))["content"], serde_json::json!("ar2"));

        // /api/config is a permanent tombstone
        let config = http_post(addr, "/api/config", "{}");
        assert_eq!(status_of(&config), 410, "config: {config}");
        assert_eq!(
            json_of(&config)["error"],
            serde_json::json!("deprecated: use /api/projects")
        );

        // storage.jsx detect() probes GET /api/health and keys on ok:true
        let detect = http_get(addr, "/api/health");
        assert_eq!(status_of(&detect), 200);
        assert!(detect.contains(r#""ok":true"#), "detect body: {detect}");
    }

    #[test]
    fn patch_rename_keeps_id_and_allows_duplicate_names() {
        let tmp = TempDir::new("api-rename");
        let addr = spawn(&tmp);
        let a = register_project(addr, &tmp_project_path(&tmp, "a"), Some("Alpha"));
        let b = register_project(addr, &tmp_project_path(&tmp, "b"), Some("Beta"));

        let rename = http_patch(
            addr,
            &format!("/api/projects/{b}"),
            r#"{"name":"Renamed"}"#,
        );
        assert_eq!(status_of(&rename), 200, "rename: {rename}");
        assert_eq!(json_of(&rename)["ok"], serde_json::json!(true));

        let listing = json_of(&http_get(addr, "/api/projects"));
        let entry = listing["projects"]
            .as_array()
            .expect("projects array")
            .iter()
            .find(|p| p["id"] == serde_json::json!(b))
            .expect("renamed project still listed under its id")
            .clone();
        assert_eq!(entry["name"], serde_json::json!("Renamed"));

        // Duplicate display names are allowed
        let dup = http_patch(
            addr,
            &format!("/api/projects/{a}"),
            r#"{"name":"Renamed"}"#,
        );
        assert_eq!(status_of(&dup), 200, "duplicate rename: {dup}");
    }

    #[test]
    fn delete_reassigns_default_rejects_last_and_removes_files_on_request() {
        let tmp = TempDir::new("api-delete");
        let addr = spawn(&tmp);
        let a = register_project(addr, &tmp_project_path(&tmp, "a"), None);
        let b = register_project(addr, &tmp_project_path(&tmp, "b"), None);

        // Deleting the default reassigns and reports the new default
        let del = http_delete(addr, &format!("/api/projects/{a}"));
        assert_eq!(status_of(&del), 200, "delete default: {del}");
        let del_json = json_of(&del);
        assert_eq!(del_json["ok"], serde_json::json!(true));
        assert_eq!(del_json["defaultProjectId"], serde_json::json!(b));

        // The legacy unscoped surface now serves the new default
        let health = json_of(&http_get(addr, "/api/health"));
        assert!(
            health["masterPath"].as_str().unwrap_or_default().contains("b/backlog.md"),
            "new default masterPath: {}",
            health["masterPath"]
        );

        // The last remaining project cannot be deleted
        let last = http_delete(addr, &format!("/api/projects/{b}"));
        assert_eq!(status_of(&last), 400, "delete last: {last}");
        assert_eq!(
            json_of(&last)["error"],
            serde_json::json!("cannot remove the last remaining project")
        );
        assert_eq!(json_of(&http_get(addr, "/api/projects"))["projects"].as_array().map(Vec::len), Some(1));

        // Unknown id
        let unknown = http_delete(addr, "/api/projects/p_does_not_exist");
        assert_eq!(status_of(&unknown), 404, "delete unknown: {unknown}");

        // delete_files=true removes exactly the project's three artifacts
        let c = register_project(addr, &tmp_project_path(&tmp, "c"), None);
        let c_dir = tmp.path().join("c");
        std::fs::write(c_dir.join("archive.md"), b"arch").expect("seed archive");
        std::fs::create_dir_all(c_dir.join("backups")).expect("seed backups dir");
        std::fs::write(c_dir.join("backups").join("backlog_1.md"), b"bk").expect("seed backup");
        std::fs::write(c_dir.join("keep.txt"), b"keep").expect("seed bystander");

        let del_files = http_delete(addr, &format!("/api/projects/{c}?delete_files=true"));
        assert_eq!(status_of(&del_files), 200, "delete files: {del_files}");
        assert!(!c_dir.join("backlog.md").exists(), "backlog.md removed");
        assert!(!c_dir.join("archive.md").exists(), "archive.md removed");
        assert!(!c_dir.join("backups").exists(), "backups/ removed");
        assert!(c_dir.join("keep.txt").exists(), "bystander file survives");

        // delete_files=false (default) keeps files on disk
        let d = register_project(addr, &tmp_project_path(&tmp, "d"), None);
        let del_keep = http_delete(addr, &format!("/api/projects/{d}"));
        assert_eq!(status_of(&del_keep), 200, "delete keep: {del_keep}");
        assert!(tmp.path().join("d").join("backlog.md").exists(), "file kept");
    }

    #[test]
    fn unknown_or_malformed_scoped_id_yields_404() {
        let tmp = TempDir::new("api-404");
        let addr = spawn(&tmp);
        let a = register_project(addr, &tmp_project_path(&tmp, "a"), None);

        let unknown = http_get(addr, "/api/projects/p_nope/backlog");
        assert_eq!(status_of(&unknown), 404, "unknown id: {unknown}");
        assert_eq!(json_of(&unknown)["error"], serde_json::json!("unknown project"));

        for probe in [
            "../backlog",
            "../x/backlog",
            "%2e%2e/backlog",
            "%2e%2e%2fbacklog",
            "..%2fbacklog",
        ] {
            let raw = http_get(addr, &format!("/api/projects/{probe}"));
            assert_eq!(status_of(&raw), 404, "traversal probe {probe:?}: {raw}");
        }

        // Over-long id (shape violation before any registry/filesystem work)
        let long_id = format!("p_{}", "a".repeat(100));
        let raw = http_get(addr, &format!("/api/projects/{long_id}/backlog"));
        assert_eq!(status_of(&raw), 404, "over-long id: {raw}");

        // Unknown id on PATCH too
        let patch = http_patch(addr, "/api/projects/p_nope", r#"{"name":"x"}"#);
        assert_eq!(status_of(&patch), 404, "patch unknown: {patch}");

        // Sanity: the well-formed id still resolves
        assert_eq!(status_of(&http_get(addr, &format!("/api/projects/{a}/health"))), 200);
    }

    #[test]
    fn host_spoof_rejected_with_403() {
        let tmp = TempDir::new("api-host");
        let addr = spawn(&tmp);

        let evil = http(
            addr,
            "GET /api/health HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n",
        );
        assert_eq!(status_of(&evil), 403, "spoofed host: {evil}");
        assert!(evil.contains("forbidden host"), "403 body: {evil}");

        let evil_static = http(
            addr,
            "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        );
        assert_eq!(status_of(&evil_static), 403, "non-loopback host: {evil_static}");

        let ok = http_get(addr, "/api/health");
        assert_eq!(status_of(&ok), 200, "loopback host: {ok}");
    }

    #[test]
    fn no_access_control_allow_origin_in_any_response() {
        let tmp = TempDir::new("api-acao");
        let addr = spawn(&tmp);
        let a = register_project(addr, &tmp_project_path(&tmp, "a"), None);

        let responses = [
            http_get(addr, "/api/health"),
            http_get(addr, "/api/projects"),
            http_get(addr, &format!("/api/projects/{a}/backlog")),
            http_post(addr, "/api/backlog", r#"{"content":"x"}"#),
            http_get(addr, "/"),
            http_options(addr, "/api/backlog"),
            http(
                addr,
                "GET /api/health HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n",
            ),
        ];
        for raw in &responses {
            assert!(
                !headers_of(raw).to_ascii_lowercase().contains("access-control-allow-origin"),
                "ACAO leaked: {raw}"
            );
        }

        // The preflight still advertises the full method set
        let preflight = http_options(addr, "/api/backlog");
        assert!(headers_of(&preflight).contains("GET, POST, PATCH, DELETE, OPTIONS"), "preflight: {preflight}");
        assert!(headers_of(&preflight).contains("Access-Control-Allow-Headers: Content-Type"), "preflight: {preflight}");
    }

    #[test]
    fn pick_folder_without_app_handle_is_501() {
        let tmp = TempDir::new("api-pick");
        let addr = spawn(&tmp);

        let raw = http_post(addr, "/api/pick-folder", "{}");
        assert_eq!(status_of(&raw), 501, "pick-folder: {raw}");
        assert_eq!(json_of(&raw)["error"], serde_json::json!("picker unavailable"));
    }

    #[test]
    fn projects_listing_shape() {
        let tmp = TempDir::new("api-list");
        let addr = spawn(&tmp);
        let a = register_project(addr, &tmp_project_path(&tmp, "a"), Some("Alpha"));
        let _b = register_project(addr, &tmp_project_path(&tmp, "b"), Some("Beta"));

        let raw = http_get(addr, "/api/projects");
        assert_eq!(status_of(&raw), 200, "listing: {raw}");
        let listing = json_of(&raw);
        let projects = listing["projects"].as_array().expect("projects array");
        assert_eq!(projects.len(), 2);

        let defaults = projects
            .iter()
            .filter(|p| p["default"] == serde_json::json!(true))
            .count();
        assert_eq!(defaults, 1, "exactly one default: {listing}");
        assert!(
            projects.iter().any(|p| p["id"] == serde_json::json!(a) && p["default"] == serde_json::json!(true)),
            "first registered project is the default: {listing}"
        );

        for project in projects {
            assert!(project["id"].as_str().is_some_and(|id| id.starts_with("p_")), "id: {project}");
            assert!(project["name"].as_str().is_some_and(|n| !n.is_empty()), "name: {project}");
            assert!(
                project["path"].as_str().is_some_and(|p| p.ends_with("backlog.md")),
                "path: {project}"
            );
            assert_eq!(project["exists"], serde_json::json!(true), "exists: {project}");
            assert!(
                project["checksum"].as_str().is_some_and(|c| !c.is_empty()),
                "checksum for existing file: {project}"
            );
            assert!(
                project["savedAtMs"].as_u64().is_some_and(|ms| ms > 0),
                "savedAtMs for existing file: {project}"
            );
        }
    }

    #[test]
    fn malformed_bodies_yield_graceful_json_not_panic() {
        let tmp = TempDir::new("api-malformed");
        let addr = spawn(&tmp);
        let a = register_project(addr, &tmp_project_path(&tmp, "a"), None);

        let bad_register = http_post(addr, "/api/projects", "not json at all");
        assert_eq!(status_of(&bad_register), 400, "bad register: {bad_register}");
        assert!(json_of(&bad_register)["error"].as_str().is_some(), "error field: {bad_register}");

        let missing_path = http_post(addr, "/api/projects", r#"{"name":"x"}"#);
        assert_eq!(status_of(&missing_path), 400, "missing path: {missing_path}");

        let non_string_path = http_post(addr, "/api/projects", r#"{"path":123}"#);
        assert_eq!(status_of(&non_string_path), 400, "non-string path: {non_string_path}");

        let invalid_path = http_post(addr, "/api/projects", r#"{"path":"/nonexistent/nope.txt"}"#);
        assert_eq!(status_of(&invalid_path), 400, "invalid path: {invalid_path}");

        // Legacy handler keeps its byte-compatible graceful error (200 + JSON)
        let bad_backlog = http_post(addr, &format!("/api/projects/{a}/backlog"), "not json");
        assert_eq!(status_of(&bad_backlog), 200, "bad backlog save: {bad_backlog}");
        assert_eq!(json_of(&bad_backlog)["error"], serde_json::json!("Invalid JSON"));

        let bad_rename = http_patch(addr, &format!("/api/projects/{a}"), "not json");
        assert_eq!(status_of(&bad_rename), 400, "bad rename: {bad_rename}");

        // The accept loop survived all of the above
        let alive = http_get(addr, "/api/health");
        assert_eq!(status_of(&alive), 200);
        assert!(alive.contains(r#""ok":true"#), "server alive: {alive}");
        assert!(!body_of(&alive).is_empty());
    }
}
