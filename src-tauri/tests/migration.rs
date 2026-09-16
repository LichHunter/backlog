//! Integration tests for the startup migration from the legacy
//! single-project layout (todo 8).
//!
//! The migration never registers a source in place: the chosen `backlog.md`
//! (plus sibling `archive.md` and `backups/`) is COPIED into `<root>/data/`
//! and the copy is registered as the default project "Backlog". Candidates
//! byte-identical to a fresh seed (the bundled example or the skeleton)
//! carry no user data and are ignored.

mod common;

use backlog_app_lib::registry::{Registry, DEFAULT_BACKLOG_SKELETON};
use backlog_app_lib::{bootstrap_registry, default_data_root};
use common::TempDir;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent dirs");
    }
    fs::write(path, content).expect("write file");
}

fn empty_registry(root: &Path) -> Registry {
    let registry = Registry::with_path(root.join("projects.json"));
    registry.load_or_default();
    registry
}

/// The exe-relative location seed detection reads the bundled example from
/// (`<exe_dir>/../Resources/testdata/backlog.md`). In tests the exe is the
/// test binary under `target/{debug,release}/deps`, so this normally does
/// not exist — the planted-example test below writes it deliberately.
fn exe_testdata_path() -> PathBuf {
    std::env::current_exe()
        .expect("current exe")
        .parent()
        .expect("exe parent")
        .join("../Resources/testdata/backlog.md")
}

/// Serializes the one env-mutating test: env is process-global and the other
/// tests in this binary run in parallel threads (none of them read
/// `BACKLOG_DATA_HOME`, so a plain static mutex suffices).
static ENV_LOCK: Mutex<()> = Mutex::new(());

mod migration {
    use super::*;

    #[test]
    fn legacy_data_is_copied_out_and_registered_from_the_copy() {
        // Given: legacy data (backlog + archive + backups) in a fake Resources dir
        let tmp = TempDir::new("m8-legacy");
        let legacy = tmp.path().join("Resources").join("data");
        write(&legacy.join("backlog.md"), "# Legacy user data\n");
        write(&legacy.join("archive.md"), "# Legacy archive\n");
        write(&legacy.join("backups").join("b1.md"), "# backup one\n");
        write(&legacy.join("backups").join("b2.md"), "# backup two\n");
        let source_mtime = fs::metadata(legacy.join("backlog.md"))
            .expect("source metadata")
            .modified()
            .expect("source mtime");
        let root = tmp.path().join("home");
        let registry = empty_registry(&root);

        // When: bootstrapping an empty registry with the legacy dir
        bootstrap_registry(&registry, &root, std::slice::from_ref(&legacy));

        // Then: one project named Backlog, registered at the COPY, default
        let projects = registry.list();
        assert_eq!(projects.len(), 1, "projects: {:?}", projects);
        assert_eq!(projects[0].name, "Backlog");
        assert_eq!(projects[0].path, root.join("data").join("backlog.md"));
        assert_eq!(
            registry.default().expect("default project").path,
            root.join("data").join("backlog.md")
        );

        // And: content carried over (backlog, archive, backups)
        let data = root.join("data");
        assert_eq!(
            fs::read_to_string(data.join("backlog.md")).unwrap(),
            "# Legacy user data\n"
        );
        assert_eq!(
            fs::read_to_string(data.join("archive.md")).unwrap(),
            "# Legacy archive\n"
        );
        assert_eq!(
            fs::read_to_string(data.join("backups").join("b1.md")).unwrap(),
            "# backup one\n"
        );
        assert_eq!(
            fs::read_to_string(data.join("backups").join("b2.md")).unwrap(),
            "# backup two\n"
        );

        // And: the originals are untouched (content + mtime)
        assert_eq!(
            fs::read_to_string(legacy.join("backlog.md")).unwrap(),
            "# Legacy user data\n"
        );
        assert!(legacy.join("archive.md").exists());
        assert!(legacy.join("backups").join("b1.md").exists());
        let after_mtime = fs::metadata(legacy.join("backlog.md"))
            .expect("source metadata after")
            .modified()
            .expect("source mtime after");
        assert_eq!(source_mtime, after_mtime, "source mtime must not change");
    }

    #[test]
    fn seed_equal_skeleton_candidate_is_ignored_and_fresh_skeleton_registered() {
        // Given: a legacy candidate byte-identical to a fresh skeleton
        let tmp = TempDir::new("m8-seed");
        let legacy = tmp.path().join("Resources").join("data");
        write(&legacy.join("backlog.md"), DEFAULT_BACKLOG_SKELETON);
        let root = tmp.path().join("home");
        let registry = empty_registry(&root);

        // When: bootstrapping
        bootstrap_registry(&registry, &root, std::slice::from_ref(&legacy));

        // Then: the seed is NOT used as data — a fresh skeleton is registered
        let backlog = root.join("data").join("backlog.md");
        assert_eq!(
            fs::read_to_string(&backlog).unwrap(),
            DEFAULT_BACKLOG_SKELETON
        );
        let projects = registry.list();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, backlog);
    }

    #[test]
    fn seed_equal_to_bundled_example_candidate_is_ignored() {
        // Given: a planted bundled example next to the test binary, and a
        // legacy candidate byte-identical to it
        let plant = exe_testdata_path();
        let example = "# Planted bundled example\nplanted for seed detection\n";
        write(&plant, example);
        let tmp = TempDir::new("m8-example");
        let legacy = tmp.path().join("Resources").join("data");
        write(&legacy.join("backlog.md"), example);
        let root = tmp.path().join("home");
        let registry = empty_registry(&root);

        // When: bootstrapping
        bootstrap_registry(&registry, &root, std::slice::from_ref(&legacy));
        let _ = fs::remove_file(&plant); // clean up even on assert failure below

        // Then: the example-equal candidate is ignored; fresh skeleton wins
        assert_eq!(
            fs::read_to_string(root.join("data").join("backlog.md")).unwrap(),
            DEFAULT_BACKLOG_SKELETON,
            "example-equal candidate must not be treated as user data"
        );
        assert_eq!(registry.list().len(), 1);
    }

    #[test]
    fn dot_app_candidate_is_only_ever_a_copy_source() {
        // Given: user data inside a bundle-style path containing /.app/
        let tmp = TempDir::new("m8-app");
        let bundled = tmp.path().join("Fake.app").join("Resources").join("data");
        write(&bundled.join("backlog.md"), "# From the bundle\n");
        let root = tmp.path().join("home");
        let registry = empty_registry(&root);

        // When: bootstrapping with the .app-internal dir
        bootstrap_registry(&registry, &root, std::slice::from_ref(&bundled));

        // Then: registered path is the COPY under root/data, never the .app path
        let projects = registry.list();
        assert_eq!(projects.len(), 1);
        let registered = projects[0].path.to_string_lossy().to_string();
        assert!(
            !registered.contains("/.app/"),
            "must never register a /.app/ path: {registered}"
        );
        assert_eq!(projects[0].path, root.join("data").join("backlog.md"));
        // And: the copy carries the bundle's content; the source remains
        assert_eq!(
            fs::read_to_string(root.join("data").join("backlog.md")).unwrap(),
            "# From the bundle\n"
        );
        assert!(bundled.join("backlog.md").exists());
    }

    #[test]
    fn nonempty_registry_is_a_noop() {
        // Given: a registry that already has a project, plus plantable legacy data
        let tmp = TempDir::new("m8-noop");
        let root = tmp.path().join("home");
        write(&root.join("backlog.md"), "# Legacy at root\n");
        let registry = empty_registry(&root);
        let existing = registry
            .register(
                root.join("existing.md").to_str().unwrap(),
                Some("Existing".into()),
            )
            .expect("register existing");

        // When: bootstrapping
        bootstrap_registry(&registry, &root, &[]);

        // Then: nothing changed — same single project, no copy-out
        let after = registry.list();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].id, existing.id);
        assert_eq!(after[0].path, root.join("existing.md"));
        assert!(
            !root.join("data").exists(),
            "no copy-out when registry is populated"
        );
    }

    #[test]
    fn empty_world_seeds_skeleton_as_default_project() {
        // Given: a fresh world — no candidates anywhere
        let tmp = TempDir::new("m8-empty");
        let root = tmp.path().join("home");
        let registry = empty_registry(&root);

        // When: bootstrapping
        bootstrap_registry(&registry, &root, &[]);

        // Then: root/data/backlog.md exists with the skeleton and is the default
        let backlog = root.join("data").join("backlog.md");
        assert!(backlog.is_file(), "seeded backlog must exist");
        assert_eq!(
            fs::read_to_string(&backlog).unwrap(),
            DEFAULT_BACKLOG_SKELETON
        );
        let projects = registry.list();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "Backlog");
        assert_eq!(projects[0].path, backlog);
        assert_eq!(registry.default().expect("default project").path, backlog);
    }

    #[test]
    fn selection_prefers_root_over_data_and_legacy_dirs() {
        // Given: non-seed candidates at root, root/data, and a legacy dir
        let tmp = TempDir::new("m8-order-r");
        let root = tmp.path().join("home");
        let legacy = tmp.path().join("Resources").join("data");
        write(&root.join("backlog.md"), "# from root\n");
        write(&root.join("data").join("backlog.md"), "# from data\n");
        write(&legacy.join("backlog.md"), "# from legacy\n");
        let registry = empty_registry(&root);

        // When: bootstrapping
        bootstrap_registry(&registry, &root, &[legacy]);

        // Then: the root candidate wins
        assert_eq!(
            fs::read_to_string(root.join("data").join("backlog.md")).unwrap(),
            "# from root\n"
        );
    }

    #[test]
    fn selection_prefers_data_over_legacy_dirs_when_root_absent() {
        // Given: non-seed candidates at root/data and a legacy dir only
        let tmp = TempDir::new("m8-order-d");
        let root = tmp.path().join("home");
        let legacy = tmp.path().join("Resources").join("data");
        write(&root.join("data").join("backlog.md"), "# from data\n");
        write(&legacy.join("backlog.md"), "# from legacy\n");
        let registry = empty_registry(&root);

        // When: bootstrapping
        bootstrap_registry(&registry, &root, std::slice::from_ref(&legacy));

        // Then: root/data wins; a same-location copy is a no-op (content intact)
        assert_eq!(
            fs::read_to_string(root.join("data").join("backlog.md")).unwrap(),
            "# from data\n"
        );
        assert_eq!(
            fs::read_to_string(legacy.join("backlog.md")).unwrap(),
            "# from legacy\n"
        );
    }

    #[test]
    fn corrupt_candidate_is_copied_verbatim_without_panicking() {
        // Given: a legacy candidate with garbage (non-UTF8) content
        let tmp = TempDir::new("m8-corrupt");
        let legacy = tmp.path().join("Resources").join("data");
        fs::create_dir_all(&legacy).expect("create legacy dir");
        let garbage: &[u8] = &[0x00, 0xff, 0xfe, b'~', 0x00];
        fs::write(legacy.join("backlog.md"), garbage).expect("write garbage");
        let root = tmp.path().join("home");
        let registry = empty_registry(&root);

        // When: bootstrapping (no panic — the test reaching Then proves it)
        bootstrap_registry(&registry, &root, &[legacy]);

        // Then: bytes are copied verbatim and the copy is registered
        let copied = root.join("data").join("backlog.md");
        assert_eq!(fs::read(&copied).unwrap(), garbage);
        assert_eq!(registry.list()[0].path, copied);
    }

    #[test]
    fn empty_candidate_file_is_copied_and_registered() {
        // Given: a zero-byte legacy candidate (no dir-creating write helper)
        let tmp = TempDir::new("m8-empty-file");
        let legacy = tmp.path().join("Resources").join("data");
        fs::create_dir_all(&legacy).expect("create legacy dir");
        fs::write(legacy.join("backlog.md"), b"").expect("write empty");
        let root = tmp.path().join("home");
        let registry = empty_registry(&root);

        // When: bootstrapping
        bootstrap_registry(&registry, &root, &[legacy]);

        // Then: copied and registered as-is
        let copied = root.join("data").join("backlog.md");
        assert_eq!(fs::read(&copied).unwrap(), b"");
        assert_eq!(registry.list()[0].path, copied);
    }

    #[test]
    fn missing_legacy_dir_is_skipped() {
        // Given: a legacy dir that does not exist
        let tmp = TempDir::new("m8-missing");
        let root = tmp.path().join("home");
        let registry = empty_registry(&root);

        // When: bootstrapping with the missing dir
        bootstrap_registry(&registry, &root, &[tmp.path().join("does-not-exist")]);

        // Then: falls through to the fresh-skeleton floor
        assert_eq!(
            fs::read_to_string(root.join("data").join("backlog.md")).unwrap(),
            DEFAULT_BACKLOG_SKELETON
        );
    }

    #[test]
    #[cfg(unix)]
    fn unreadable_legacy_dir_is_skipped_without_panicking() {
        // Given: a legacy dir whose contents cannot be traversed
        let tmp = TempDir::new("m8-unreadable");
        let legacy = tmp.path().join("Resources").join("data");
        write(&legacy.join("backlog.md"), "# unreachable\n");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&legacy, fs::Permissions::from_mode(0o000))
            .expect("chmod 000");
        let root = tmp.path().join("home");
        let registry = empty_registry(&root);

        // When: bootstrapping (reaching Then without a panic is the assertion)
        bootstrap_registry(&registry, &root, std::slice::from_ref(&legacy));
        fs::set_permissions(&legacy, fs::Permissions::from_mode(0o755))
            .expect("restore perms for TempDir cleanup");

        // Then: the unreadable candidate is skipped; fresh skeleton floor
        assert_eq!(
            fs::read_to_string(root.join("data").join("backlog.md")).unwrap(),
            DEFAULT_BACKLOG_SKELETON
        );
    }

    #[test]
    fn backlog_data_home_env_overrides_default_root() {
        // Given: BACKLOG_DATA_HOME pointing at a specific dir (env is
        // process-global — the ENV_LOCK mutex serializes this test)
        let _guard = ENV_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let tmp = TempDir::new("m8-env");
        let override_dir = tmp.path().join("data-home");
        fs::create_dir_all(&override_dir).expect("create override dir");

        // When: resolving the default root with the env var set
        std::env::set_var("BACKLOG_DATA_HOME", &override_dir);
        let resolved = default_data_root();
        std::env::remove_var("BACKLOG_DATA_HOME");

        // Then: the env var wins
        assert_eq!(resolved, override_dir);
    }
}
