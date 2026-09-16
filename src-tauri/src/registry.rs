// allow: SIZE_OK — plan-mandated single-file module (todo 2 file map); one
// responsibility (registry persistence) and a spec-mandated public API surface.
//! Multi-project registry: the persistent list of known projects with atomic
//! saves and quarantine-on-corruption recovery.

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Registry format version; files carrying any other value are quarantined.
const REGISTRY_VERSION: u32 = 1;
const RENAME_ATTEMPTS: u32 = 3;
const RETRY_DELAY: Duration = Duration::from_millis(50);

/// Default backlog.md content, byte-identical to the server's skeleton.
const DEFAULT_BACKLOG_SKELETON: &str = "# Backlog\n\n<!-- SECTION: ENTRIES -->\n\n<!-- SECTION: HISTORY -->\n\n| Timestamp | Item ID | Action | Details |\n|-----------|---------|--------|--------|\n\n<!-- SECTION: INTEGRITY -->\n\n<!-- saved: | checksum: | entries: 0 | history: 0 -->\n";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RegistryData {
    pub version: u32,
    pub default_project_id: String,
    pub projects: Vec<Project>,
}

impl Default for RegistryData {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            default_project_id: String::new(),
            projects: Vec::new(),
        }
    }
}

/// Outcome of a successful removal; carries the reassigned default, if any.
#[derive(Debug)]
pub struct RemoveOutcome {
    pub new_default_id: Option<String>,
}

#[derive(Debug)]
pub enum RegistryError {
    UnknownProject,
    LastProject,
    InvalidPath,
    Io(io::Error),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegistryError::UnknownProject => write!(f, "unknown project"),
            RegistryError::LastProject => write!(f, "cannot remove the last remaining project"),
            RegistryError::InvalidPath => {
                write!(f, "invalid path: expected a directory or a .md file")
            }
            RegistryError::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl Error for RegistryError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            RegistryError::Io(e) => Some(e),
            _ => None,
        }
    }
}

impl From<io::Error> for RegistryError {
    fn from(e: io::Error) -> Self {
        RegistryError::Io(e)
    }
}

pub struct Registry {
    inner: RwLock<RegistryData>,
    path: PathBuf,
}

impl Registry {
    pub fn with_path(path: PathBuf) -> Self {
        Self {
            inner: RwLock::new(RegistryData::default()),
            path,
        }
    }

    /// Loads the registry file, or resets to the empty default state.
    ///
    /// An absent file, a parse error, or an unsupported version all yield the
    /// empty default; unreadable/corrupt/unsupported files are renamed aside
    /// (quarantined) so the next save starts from a clean slate. Never panics.
    pub fn load_or_default(&self) {
        if !self.path.exists() {
            *self.inner.write() = RegistryData::default();
            return;
        }
        let parsed = fs::read_to_string(&self.path)
            .map_err(|e| format!("read error: {e}"))
            .and_then(|text| {
                serde_json::from_str::<RegistryData>(&text).map_err(|e| format!("parse error: {e}"))
            });
        *self.inner.write() = match parsed {
            Ok(data) if data.version == REGISTRY_VERSION => data,
            Ok(data) => {
                let reason = format!("unsupported version {}", data.version);
                self.quarantine(&reason);
                RegistryData::default()
            }
            Err(reason) => {
                self.quarantine(&reason);
                RegistryData::default()
            }
        };
    }

    /// Serializes the registry pretty-printed to a sibling temp file, then
    /// renames it over the target. Renames are retried (Windows AV locks).
    pub fn save_atomic(&self) -> io::Result<()> {
        let json = serde_json::to_string_pretty(&*self.inner.read()).map_err(io::Error::other)?;
        let mut tmp_name = self.path.clone().into_os_string();
        tmp_name.push(format!(".tmp-{}", std::process::id()));
        let tmp = PathBuf::from(tmp_name);
        fs::write(&tmp, json)?;

        let mut attempts = 0;
        loop {
            attempts += 1;
            match fs::rename(&tmp, &self.path) {
                Ok(()) => return Ok(()),
                Err(_) if attempts < RENAME_ATTEMPTS => thread::sleep(RETRY_DELAY),
                Err(e) => {
                    let _ = fs::remove_file(&tmp);
                    return Err(e);
                }
            }
        }
    }

    /// Registers a project for `dir_or_file` and returns it.
    ///
    /// A directory maps to `<dir>/backlog.md`; a `.md` path is used as-is;
    /// anything else is `InvalidPath`. Missing parent directories are created;
    /// a missing target file is seeded with the default skeleton. The first
    /// project registered becomes the default.
    pub fn register(
        &self,
        dir_or_file: &str,
        name: Option<String>,
    ) -> Result<Arc<Project>, RegistryError> {
        let input = Path::new(dir_or_file);
        let path = if input.is_dir() {
            input.join("backlog.md")
        } else if dir_or_file.ends_with(".md") {
            input.to_path_buf()
        } else {
            return Err(RegistryError::InvalidPath);
        };

        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(parent)?;
            }
        }
        if !path.exists() {
            fs::write(&path, DEFAULT_BACKLOG_SKELETON)?;
        }

        let id = format!("p_{}", uuid::Uuid::new_v4().simple());
        let name = name.unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "project".to_string())
        });
        let project = Arc::new(Project {
            id: id.clone(),
            name,
            path,
        });

        {
            let mut data = self.inner.write();
            if data.projects.is_empty() {
                data.default_project_id = id;
            }
            data.projects.push((*project).clone());
        }
        self.save_atomic()?;
        Ok(project)
    }

    /// Renames a project's display name; the id and path never change and
    /// duplicate display names are allowed.
    pub fn rename(&self, id: &str, new_name: &str) -> Result<(), RegistryError> {
        {
            let mut data = self.inner.write();
            let Some(project) = data.projects.iter_mut().find(|p| p.id == id) else {
                return Err(RegistryError::UnknownProject);
            };
            project.name = new_name.to_string();
        }
        self.save_atomic()?;
        Ok(())
    }

    /// Removes a project. The last remaining project cannot be removed.
    /// With `delete_files`, removes exactly the project's backlog file, its
    /// sibling `archive.md`, and its sibling `backups/` directory — nothing else.
    pub fn remove(&self, id: &str, delete_files: bool) -> Result<RemoveOutcome, RegistryError> {
        let (project, new_default_id) = {
            let mut data = self.inner.write();
            let Some(index) = data.projects.iter().position(|p| p.id == id) else {
                return Err(RegistryError::UnknownProject);
            };
            if data.projects.len() == 1 {
                return Err(RegistryError::LastProject);
            }
            let project = data.projects.remove(index);
            let new_default_id = if data.default_project_id == id {
                let new_id = data
                    .projects
                    .first()
                    .map(|p| p.id.clone())
                    .unwrap_or_default();
                data.default_project_id = new_id.clone();
                Some(new_id)
            } else {
                None
            };
            (project, new_default_id)
        };

        if delete_files {
            let _ = fs::remove_file(&project.path);
            if let Some(parent) = project.path.parent() {
                let _ = fs::remove_file(parent.join("archive.md"));
                let _ = fs::remove_dir_all(parent.join("backups"));
            }
        }
        self.save_atomic()?;
        Ok(RemoveOutcome { new_default_id })
    }

    pub fn set_default(&self, id: &str) -> Result<(), RegistryError> {
        {
            let mut data = self.inner.write();
            if !data.projects.iter().any(|p| p.id == id) {
                return Err(RegistryError::UnknownProject);
            }
            data.default_project_id = id.to_string();
        }
        self.save_atomic()?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<Arc<Project>> {
        self.inner
            .read()
            .projects
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .map(Arc::new)
    }

    pub fn list(&self) -> Vec<Project> {
        self.inner.read().projects.clone()
    }

    pub fn default(&self) -> Option<Arc<Project>> {
        let data = self.inner.read();
        data.projects
            .iter()
            .find(|p| p.id == data.default_project_id)
            .cloned()
            .map(Arc::new)
    }

    fn quarantine(&self, reason: &str) {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".corrupt-{ts}"));
        let dest = PathBuf::from(name);
        match fs::rename(&self.path, &dest) {
            Ok(()) => log::warn!(
                "registry {:?} is corrupt ({}); quarantined to {:?}",
                self.path,
                reason,
                dest
            ),
            Err(e) => log::warn!(
                "failed to quarantine corrupt registry {:?} ({}): {}",
                self.path,
                reason,
                e
            ),
        }
    }
}
