//! Integration tests for the project registry (todo 2).
//!
//! Tests live inside `mod registry` so `cargo test registry` matches every
//! test name via the standard substring filter.

use backlog_app_lib::registry::{Registry, RegistryError};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static DIR_COUNTER: AtomicU32 = AtomicU32::new(0);

/// Hand-rolled tempdir (no dev-dep): pid + counter + tag guards collisions.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let n = DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "backlog-registry-test-{}-{}-{}",
            tag,
            std::process::id(),
            n
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        TempDir(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn registry_path(tmp: &TempDir) -> PathBuf {
    tmp.path().join("projects.json")
}

mod registry {
    use super::*;

    #[test]
    fn roundtrip_save_then_load_returns_same_projects_and_default() {
        // Given: a registry with two registered (and atomically saved) projects
        let tmp = TempDir::new("roundtrip");
        let reg = Registry::with_path(registry_path(&tmp));
        let dir_a = tmp.path().join("a");
        fs::create_dir_all(&dir_a).unwrap();
        let a = reg
            .register(dir_a.to_str().unwrap(), Some("Alpha".into()))
            .unwrap();
        let b = reg
            .register(
                tmp.path().join("notes.md").to_str().unwrap(),
                Some("Beta".into()),
            )
            .unwrap();

        // When: a fresh Registry loads from the same path
        let reloaded = Registry::with_path(registry_path(&tmp));
        reloaded.load_or_default();

        // Then: the persisted JSON carries the documented camelCase shape
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(registry_path(&tmp)).unwrap()).unwrap();
        assert_eq!(raw["version"], serde_json::json!(1));
        assert!(raw["defaultProjectId"].is_string());
        assert!(raw["projects"].is_array());

        // And: projects and default survive the round-trip
        let list = reloaded.list();
        assert_eq!(list.len(), 2);
        let ra = list
            .iter()
            .find(|p| p.id == a.id)
            .expect("project A survived");
        assert_eq!(ra.name, "Alpha");
        assert_eq!(ra.path, dir_a.join("backlog.md"));
        assert!(list.iter().any(|p| p.id == b.id && p.name == "Beta"));
        assert_eq!(reloaded.default().expect("default exists").id, a.id);
    }

    #[test]
    fn load_or_default_quarantines_corrupt_json_without_panic() {
        // Given: a registry file that is not valid JSON
        let tmp = TempDir::new("corrupt");
        let reg_path = registry_path(&tmp);
        fs::write(&reg_path, "not json{{{").unwrap();

        // When: loading
        let reg = Registry::with_path(reg_path.clone());
        reg.load_or_default();

        // Then: empty state, original quarantined as a sibling, no panic
        assert!(reg.list().is_empty());
        assert!(reg.default().is_none());
        assert!(!reg_path.exists());
        let quarantined = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("projects.json.corrupt-")
            });
        assert!(quarantined, "quarantine sibling must exist");
    }

    #[test]
    fn load_or_default_quarantines_wrong_version() {
        // Given: valid JSON carrying an unsupported version
        let tmp = TempDir::new("version");
        let reg_path = registry_path(&tmp);
        fs::write(
            &reg_path,
            r#"{"version":2,"defaultProjectId":"p_x","projects":[]}"#,
        )
        .unwrap();

        // When: loading
        let reg = Registry::with_path(reg_path.clone());
        reg.load_or_default();

        // Then: quarantined + empty default state
        assert!(reg.list().is_empty());
        assert!(reg.default().is_none());
        assert!(!reg_path.exists());
        let quarantined = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("projects.json.corrupt-")
            });
        assert!(quarantined, "version-2 file must be quarantined");
    }

    #[test]
    fn register_dir_targets_backlog_md_inside_it() {
        // Given: an existing directory
        let tmp = TempDir::new("regdir");
        let dir = tmp.path().join("mydir");
        fs::create_dir_all(&dir).unwrap();
        let reg = Registry::with_path(registry_path(&tmp));

        // When: registering the directory
        let p = reg
            .register(dir.to_str().unwrap(), Some("Named".into()))
            .unwrap();

        // Then: path is <dir>/backlog.md and it exists on disk
        assert_eq!(p.path, dir.join("backlog.md"));
        assert!(p.path.exists());
        assert_eq!(p.name, "Named");
    }

    #[test]
    fn register_md_file_uses_path_as_is() {
        // Given: an existing .md file
        let tmp = TempDir::new("regfile");
        let file = tmp.path().join("existing.md");
        fs::write(&file, "# existing").unwrap();
        let reg = Registry::with_path(registry_path(&tmp));

        // When: registering the file path
        let p = reg.register(file.to_str().unwrap(), None).unwrap();

        // Then: path is used as-is, name defaults to file stem
        assert_eq!(p.path, file);
        assert_eq!(p.name, "existing");
        let on_disk = fs::read_to_string(&file).unwrap();
        assert_eq!(on_disk, "# existing", "existing file must not be rewritten");
    }

    #[test]
    fn register_missing_file_creates_skeleton() {
        // Given: a .md path whose parent can be created but file is absent
        let tmp = TempDir::new("regmiss");
        let file = tmp.path().join("fresh").join("backlog.md");
        let reg = Registry::with_path(registry_path(&tmp));

        // When: registering
        let p = reg.register(file.to_str().unwrap(), None).unwrap();

        // Then: file created with the default skeleton
        let content = fs::read_to_string(&file).unwrap();
        assert_eq!(content.split('\n').next(), Some("# Backlog"));
        assert!(content.contains("SECTION: ENTRIES"));
        assert_eq!(p.name, "backlog");
    }

    #[test]
    fn register_first_project_becomes_default_and_stays() {
        // Given: an empty registry
        let tmp = TempDir::new("firstdef");
        let reg = Registry::with_path(registry_path(&tmp));

        // When: registering two projects
        let a = reg
            .register(tmp.path().join("a.md").to_str().unwrap(), None)
            .unwrap();
        let _b = reg
            .register(tmp.path().join("b.md").to_str().unwrap(), None)
            .unwrap();

        // Then: the first one is (and stays) the default
        let default = reg.default().expect("default set");
        assert_eq!(default.id, a.id);
    }

    #[test]
    fn rename_changes_only_display_name_and_duplicates_are_allowed() {
        // Given: two registered projects
        let tmp = TempDir::new("rename");
        let reg = Registry::with_path(registry_path(&tmp));
        let a = reg
            .register(tmp.path().join("a.md").to_str().unwrap(), Some("A".into()))
            .unwrap();
        let b = reg
            .register(tmp.path().join("b.md").to_str().unwrap(), Some("B".into()))
            .unwrap();

        // When: renaming both to the same display name
        reg.rename(&a.id, "Same").unwrap();
        reg.rename(&b.id, "Same").unwrap();

        // Then: ids and paths are stable, only names changed
        let ga = reg.get(&a.id).expect("A still registered");
        let gb = reg.get(&b.id).expect("B still registered");
        assert_eq!(ga.name, "Same");
        assert_eq!(gb.name, "Same");
        assert_eq!(ga.path, a.path);
        assert_eq!(gb.path, b.path);
        assert_ne!(ga.id, gb.id);
    }

    #[test]
    fn remove_default_reassigns_to_first_remaining() {
        // Given: A (default) then B registered
        let tmp = TempDir::new("rmdef");
        let reg = Registry::with_path(registry_path(&tmp));
        let a = reg
            .register(tmp.path().join("a.md").to_str().unwrap(), None)
            .unwrap();
        let b = reg
            .register(tmp.path().join("b.md").to_str().unwrap(), None)
            .unwrap();
        assert_eq!(reg.default().unwrap().id, a.id);

        // When: removing the default project
        let outcome = reg.remove(&a.id, false).unwrap();

        // Then: default is reassigned to B and reported by the outcome
        assert_eq!(outcome.new_default_id.as_deref(), Some(b.id.as_str()));
        assert_eq!(reg.default().expect("default reassigned").id, b.id);
        assert!(reg.get(&a.id).is_none());
        assert_eq!(reg.list().len(), 1);
    }

    #[test]
    fn remove_last_project_errors_and_keeps_it_registered() {
        // Given: a registry with exactly one project
        let tmp = TempDir::new("rmlast");
        let reg = Registry::with_path(registry_path(&tmp));
        let a = reg
            .register(tmp.path().join("only.md").to_str().unwrap(), None)
            .unwrap();

        // When: attempting removal
        let err = reg.remove(&a.id, false).unwrap_err();

        // Then: LastProject error and the project is still there
        assert!(matches!(err, RegistryError::LastProject));
        assert!(reg.get(&a.id).is_some());
        assert_eq!(reg.list().len(), 1);
        assert!(reg.default().is_some());
    }

    #[test]
    fn remove_unknown_project_errors() {
        let tmp = TempDir::new("rmunk");
        let reg = Registry::with_path(registry_path(&tmp));
        reg.register(tmp.path().join("a.md").to_str().unwrap(), None)
            .unwrap();

        let err = reg.remove("p_does_not_exist", false).unwrap_err();
        assert!(matches!(err, RegistryError::UnknownProject));
    }

    #[test]
    fn remove_with_delete_files_removes_exactly_three_artifacts() {
        // Given: a project dir with backlog.md, archive.md, backups/, and an unrelated file
        let tmp = TempDir::new("rmfiles");
        let reg_dir = tmp.path().join("registry");
        fs::create_dir_all(&reg_dir).unwrap();
        let proj_dir = tmp.path().join("proj");
        fs::create_dir_all(proj_dir.join("backups")).unwrap();
        let backlog = proj_dir.join("backlog.md");
        fs::write(&backlog, "# Backlog").unwrap();
        fs::write(proj_dir.join("archive.md"), "arch").unwrap();
        fs::write(proj_dir.join("backups").join("x.md"), "x").unwrap();
        fs::write(proj_dir.join("OTHER.txt"), "keep me").unwrap();

        let reg = Registry::with_path(reg_dir.join("projects.json"));
        let a = reg.register(backlog.to_str().unwrap(), None).unwrap();
        let _b = reg
            .register(tmp.path().join("other.md").to_str().unwrap(), None)
            .unwrap();

        // When: removing with delete_files = true
        reg.remove(&a.id, true).unwrap();

        // Then: exactly backlog.md, archive.md and backups/ are gone; nothing else
        assert!(!backlog.exists());
        assert!(!proj_dir.join("archive.md").exists());
        assert!(!proj_dir.join("backups").exists());
        assert!(
            proj_dir.join("OTHER.txt").exists(),
            "unrelated file must survive"
        );
        assert!(proj_dir.exists(), "project dir itself must survive");
        assert!(
            reg_dir.join("projects.json").exists(),
            "registry file must survive"
        );
    }

    #[test]
    fn save_atomic_leaves_no_tmp_residue() {
        // Given: a registry that saved several times
        let tmp = TempDir::new("tmpres");
        let reg_path = registry_path(&tmp);
        let reg = Registry::with_path(reg_path.clone());
        reg.register(tmp.path().join("a.md").to_str().unwrap(), None)
            .unwrap();
        reg.save_atomic().unwrap();
        reg.register(tmp.path().join("b.md").to_str().unwrap(), None)
            .unwrap();

        // Then: no .tmp- siblings remain in the registry directory
        let residue: Vec<String> = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(residue.is_empty(), "unexpected tmp residue: {:?}", residue);
    }

    #[test]
    fn register_empty_path_is_invalid() {
        let tmp = TempDir::new("badpath");
        let reg = Registry::with_path(registry_path(&tmp));

        let err = reg.register("", None).unwrap_err();
        assert!(matches!(err, RegistryError::InvalidPath));
    }

    #[test]
    fn register_under_uncreatable_parent_errors() {
        // Given: a regular file acting as a directory parent
        let tmp = TempDir::new("badparent");
        let blocker = tmp.path().join("blocker.txt");
        fs::write(&blocker, "i am a file").unwrap();
        let reg = Registry::with_path(registry_path(&tmp));

        // When: registering a path whose parent chain goes through that file
        let target = blocker.join("sub").join("backlog.md");
        let result = reg.register(target.to_str().unwrap(), None);

        // Then: error (parent cannot exist or be created)
        assert!(result.is_err());
    }
}
