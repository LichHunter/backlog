#!/usr/bin/env python3
"""Personal Backlog - lightweight file server + REST API.

Zero dependencies (Python 3 stdlib only).
Usage: python3 server.py --port 8080 --dir ./data
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse


class Config:
    def __init__(self, directory: Path, port: int, web_dir: Path | None = None, workspace: bool = False):
        self.dir = directory.resolve()
        self.port = port
        self.workspace = workspace
        self.master = self.dir / "backlog.md"
        self.backups_dir = self.dir / "backups"
        self.stats_file = self.dir / "stats.jsonl"
        self.registry_file = self.dir / "projects.json"
        self.web_dir = web_dir.resolve() if web_dir else Path(__file__).parent.parent / "webapp"

    def ensure_dirs(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        if not self.workspace:
            self.backups_dir.mkdir(exist_ok=True)

    def load_registry(self) -> dict:
        if not self.registry_file.exists():
            return {}
        try:
            return json.loads(self.registry_file.read_text(encoding="utf-8"))
        except:
            return {}

    def save_registry(self, registry: dict):
        self.registry_file.write_text(json.dumps(registry, indent=2), encoding="utf-8")

    def get_project_dir(self, project_name: str) -> Path:
        return self.dir / project_name

    def get_project_master(self, project_name: str) -> Path:
        return self.get_project_dir(project_name) / "backlog.md"

    def get_project_backups_dir(self, project_name: str) -> Path:
        return self.get_project_dir(project_name) / "backups"

    def discover_projects(self) -> list:
        if not self.workspace:
            return []
        projects = []
        for d in self.dir.iterdir():
            if d.is_dir() and (d / "backlog.md").exists():
                projects.append(d.name)
        return sorted(projects)


CONFIG: Config = None  # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Markdown integrity helpers
# ---------------------------------------------------------------------------

def compute_checksum(entries_text: str, history_text: str) -> str:
    payload = entries_text + "\n" + history_text
    h = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"sha256:{h}"


def parse_markdown_sections(text: str):
    """Split markdown into entries, history, and integrity sections.
    Returns (entries_text, history_text, integrity_meta dict or None).
    """
    # Find section markers
    entries_start = text.find("<!-- SECTION: ENTRIES -->")
    history_start = text.find("<!-- SECTION: HISTORY -->")
    integrity_start = text.find("<!-- SECTION: INTEGRITY -->")

    if entries_start == -1:
        # No sections found — treat entire text as entries
        return text, "", None

    entries_text = text[entries_start:history_start if history_start != -1 else len(text)]
    history_text = ""
    integrity_meta = None

    if history_start != -1:
        end = integrity_start if integrity_start != -1 else len(text)
        history_text = text[history_start:end]

    if integrity_start != -1:
        integrity_block = text[integrity_start:]
        # Parse comment like <!-- saved: ... | checksum: ... | entries: ... | history: ... -->
        m = re.search(r"saved:\s*([^|]+?)\s*\|\s*checksum:\s*([^|]+?)\s*\|\s*entries:\s*(\d+)\s*\|\s*history:\s*(\d+)", integrity_block)
        if m:
            integrity_meta = {
                "saved": m.group(1).strip(),
                "checksum": m.group(2).strip(),
                "entries": int(m.group(3)),
                "history": int(m.group(4)),
            }

    return entries_text, history_text, integrity_meta


def make_integrity_marker(entries_text: str, history_text: str) -> str:
    checksum = compute_checksum(entries_text, history_text)
    entry_count = len(re.findall(r"^[-*] \[", entries_text, re.MULTILINE))
    history_count = len([l for l in history_text.splitlines() if l.startswith("|") and "Timestamp" not in l])
    saved = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"<!-- saved: {saved} | checksum: {checksum} | entries: {entry_count} | history: {history_count} -->"


def build_markdown(entries_text: str, history_text: str) -> str:
    marker = make_integrity_marker(entries_text, history_text)
    return f"# Backlog\n\n<!-- SECTION: ENTRIES -->\n\n{entries_text}\n\n<!-- SECTION: HISTORY -->\n\n{history_text}\n\n<!-- SECTION: INTEGRITY -->\n\n{marker}\n"


# ---------------------------------------------------------------------------
# File operations
# ---------------------------------------------------------------------------

def read_master() -> dict:
    if not CONFIG.master.exists():
        return {"content": build_markdown("", "| Timestamp | Item ID | Action | Details |\n|-----------|---------|--------|---------|"), "checksum": "", "size": 0}
    text = CONFIG.master.read_text(encoding="utf-8")
    entries, history, meta = parse_markdown_sections(text)
    checksum = meta["checksum"] if meta else ""
    return {"content": text, "checksum": checksum, "size": len(text.encode("utf-8"))}


def write_master(content: str) -> dict:
    """Atomic write with backup."""
    tmp = CONFIG.master.with_suffix(".md.tmp")
    # Write temp
    tmp.write_text(content, encoding="utf-8")
    # Verify it parses
    parse_markdown_sections(content)
    # Create backup (millis to avoid collisions)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    millis = datetime.now(timezone.utc).strftime("%f")[:3]
    backup_name = f"backlog_{timestamp}-{millis}.md"
    backup_path = CONFIG.backups_dir / backup_name
    shutil.copy2(tmp, backup_path)
    rotate_backups()
    # Atomic rename
    tmp.replace(CONFIG.master)
    # Stats
    append_stats({"t": datetime.now(timezone.utc).isoformat(), "e": "save_completed", "d": {"size": len(content.encode("utf-8"))}})
    _, _, meta = parse_markdown_sections(content)
    return {"ok": True, "checksum": meta["checksum"] if meta else "", "saved": meta["saved"] if meta else ""}


def rotate_backups():
    files = sorted(CONFIG.backups_dir.glob("backlog_*.md"), key=lambda p: p.stat().st_mtime)
    if not files:
        return
    now = datetime.now(timezone.utc)
    for f in files[:-1]:  # never delete the most recent
        age_days = (now.timestamp() - f.stat().st_mtime) / 86400
        if age_days <= 7:
            continue
        day = f.name.split("_")[1]  # YYYY-MM-DD
        same_day = [x for x in files if x.name.startswith(f"backlog_{day}")]
        if f != max(same_day, key=lambda p: p.stat().st_mtime):
            f.unlink()


def list_backups() -> list:
    result = []
    for f in sorted(CONFIG.backups_dir.glob("backlog_*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
        text = f.read_text(encoding="utf-8")
        _, _, meta = parse_markdown_sections(text)
        result.append({
            "name": f.name,
            "size": f.stat().st_size,
            "timestamp": datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc).isoformat(),
            "valid": meta is not None,
        })
    return result


def restore_backup(name: str) -> dict:
    src = CONFIG.backups_dir / name
    if not src.exists():
        return {"ok": False, "error": "Backup not found"}
    text = src.read_text(encoding="utf-8")
    parse_markdown_sections(text)
    shutil.copy2(src, CONFIG.master)
    return {"ok": True}


def read_project_master(project: str) -> dict:
    master = CONFIG.get_project_master(project)
    if not master.exists():
        return {"content": build_markdown("", "| Timestamp | Item ID | Action | Details |\n|-----------|---------|--------|---------|"), "checksum": "", "size": 0}
    text = master.read_text(encoding="utf-8")
    entries, history, meta = parse_markdown_sections(text)
    checksum = meta["checksum"] if meta else ""
    return {"content": text, "checksum": checksum, "size": len(text.encode("utf-8"))}


def write_project_master(project: str, content: str) -> dict:
    project_dir = CONFIG.get_project_dir(project)
    master = CONFIG.get_project_master(project)
    backups_dir = CONFIG.get_project_backups_dir(project)
    
    project_dir.mkdir(parents=True, exist_ok=True)
    backups_dir.mkdir(exist_ok=True)
    
    tmp = master.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    parse_markdown_sections(content)
    
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    millis = datetime.now(timezone.utc).strftime("%f")[:3]
    backup_name = f"backlog_{timestamp}-{millis}.md"
    shutil.copy2(tmp, backups_dir / backup_name)
    
    tmp.replace(master)
    _, _, meta = parse_markdown_sections(content)
    return {"ok": True, "checksum": meta["checksum"] if meta else "", "saved": meta["saved"] if meta else ""}


def list_project_backups(project: str) -> list:
    backups_dir = CONFIG.get_project_backups_dir(project)
    if not backups_dir.exists():
        return []
    result = []
    for f in sorted(backups_dir.glob("backlog_*.md"), key=lambda p: p.stat().st_mtime, reverse=True):
        text = f.read_text(encoding="utf-8")
        _, _, meta = parse_markdown_sections(text)
        result.append({
            "name": f.name,
            "size": f.stat().st_size,
            "timestamp": datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc).isoformat(),
            "valid": meta is not None,
        })
    return result


def create_project(name: str) -> dict:
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '-', name.strip())
    if not safe_name:
        return {"ok": False, "error": "Invalid project name"}
    project_dir = CONFIG.get_project_dir(safe_name)
    if project_dir.exists():
        return {"ok": False, "error": "Project already exists"}
    project_dir.mkdir(parents=True)
    master = CONFIG.get_project_master(safe_name)
    blank = build_markdown("", "| Timestamp | Item ID | Action | Details |\n|-----------|---------|--------|---------|")
    master.write_text(blank, encoding="utf-8")
    return {"ok": True, "name": safe_name}


# ---------------------------------------------------------------------------
# Registry-based project management (multi-project mode with arbitrary paths)
# ---------------------------------------------------------------------------

def register_project(file_path: str, name: str = None) -> dict:
    path = Path(file_path).expanduser().resolve()
    if not path.name.endswith(".md"):
        path = path / "backlog.md"
    
    project_name = name or path.parent.name
    safe_name = re.sub(r'[^a-zA-Z0-9_-]', '-', project_name.strip())
    if not safe_name:
        return {"ok": False, "error": "Invalid project name"}
    
    registry = CONFIG.load_registry()
    if safe_name in registry:
        return {"ok": False, "error": f"Project '{safe_name}' already registered"}
    
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        blank = build_markdown("", "| Timestamp | Item ID | Action | Details |\n|-----------|---------|--------|---------|")
        path.write_text(blank, encoding="utf-8")
    
    registry[safe_name] = {"path": str(path), "name": safe_name}
    CONFIG.save_registry(registry)
    return {"ok": True, "name": safe_name, "path": str(path)}


def unregister_project(name: str, delete_file: bool = False) -> dict:
    registry = CONFIG.load_registry()
    if name not in registry:
        return {"ok": False, "error": f"Project '{name}' not found"}
    
    file_path = Path(registry[name]["path"])
    del registry[name]
    CONFIG.save_registry(registry)
    
    if delete_file and file_path.exists():
        try:
            file_path.unlink()
            return {"ok": True, "deleted": True}
        except Exception as e:
            return {"ok": True, "deleted": False, "warning": f"Could not delete file: {e}"}
    
    return {"ok": True, "deleted": False}


def auto_register_default_project():
    registry = CONFIG.load_registry()
    if registry:
        return
    
    if not CONFIG.master.exists():
        return
    
    master_path = str(CONFIG.master.resolve())
    registry["default"] = {"path": master_path, "name": "default"}
    CONFIG.save_registry(registry)
    print(f"[init] Auto-registered default project: {master_path}")


def list_registered_projects() -> list:
    registry = CONFIG.load_registry()
    projects = []
    for name, info in registry.items():
        path = Path(info["path"])
        if path.exists():
            text = path.read_text(encoding="utf-8")
            _, _, meta = parse_markdown_sections(text)
            projects.append({
                "name": name,
                "path": str(path),
                "size": len(text.encode("utf-8")),
                "checksum": meta["checksum"] if meta else "",
            })
        else:
            projects.append({"name": name, "path": str(path), "size": 0, "checksum": "", "missing": True})
    return projects


def read_registered_project(name: str) -> dict:
    registry = CONFIG.load_registry()
    if name not in registry:
        return {"error": f"Project '{name}' not found"}
    path = Path(registry[name]["path"])
    if not path.exists():
        return {"error": f"File not found: {path}"}
    text = path.read_text(encoding="utf-8")
    _, _, meta = parse_markdown_sections(text)
    return {"content": text, "checksum": meta["checksum"] if meta else "", "size": len(text.encode("utf-8"))}


def write_registered_project(name: str, content: str) -> dict:
    registry = CONFIG.load_registry()
    if name not in registry:
        return {"ok": False, "error": f"Project '{name}' not found"}
    path = Path(registry[name]["path"])
    backup_dir = path.parent / "backups"
    backup_dir.mkdir(exist_ok=True)
    
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    millis = datetime.now(timezone.utc).strftime("%f")[:3]
    backup_name = f"backlog_{timestamp}-{millis}.md"
    backup_path = backup_dir / backup_name
    
    if path.exists():
        shutil.copy2(path, backup_path)
    
    tmp = path.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)
    
    _, _, meta = parse_markdown_sections(content)
    return {"ok": True, "checksum": meta["checksum"] if meta else "", "saved": meta["saved"] if meta else ""}


# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------

def append_stats(event: dict):
    with open(CONFIG.stats_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def read_stats(from_iso: str = None, to_iso: str = None) -> list:
    if not CONFIG.stats_file.exists():
        return []
    events = []
    with open(CONFIG.stats_file, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
                t = ev.get("t", "")
                if from_iso and t < from_iso:
                    continue
                if to_iso and t > to_iso:
                    continue
                events.append(ev)
            except json.JSONDecodeError:
                continue
    return events


# ---------------------------------------------------------------------------
# HTTP Handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Suppress default logging
        pass

    def _json_response(self, data: dict, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _text_response(self, text: str, status: int = 200, content_type: str = "text/plain"):
        body = text.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _file_response(self, path: Path, content_type: str = "application/octet-stream"):
        if not path.exists():
            self._json_response({"error": "Not found"}, 404)
            return
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        body = self.rfile.read(length).decode("utf-8")
        return json.loads(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        # Serve static files from web_dir for / and any non-API path
        if not path.startswith("/api/"):
            # Map / → index.html, otherwise strip leading /
            rel = "index-style-v2.html" if path == "/" else path.lstrip("/")
            target = (CONFIG.web_dir / rel).resolve()
            # Safety: stay inside web_dir
            try:
                target.relative_to(CONFIG.web_dir)
            except ValueError:
                self._json_response({"error": "Forbidden"}, 403)
                return
            if target.exists() and target.is_file():
                ext = target.suffix.lower()
                mime = {
                    ".html": "text/html", ".css": "text/css",
                    ".js": "application/javascript", ".jsx": "application/javascript",
                    ".json": "application/json", ".md": "text/markdown",
                    ".png": "image/png", ".svg": "image/svg+xml",
                }.get(ext, "application/octet-stream")
                self._file_response(target, mime)
            else:
                self._json_response({"error": "Not found"}, 404)
            return

        if path == "/api/health":
            if CONFIG.workspace:
                projects = CONFIG.discover_projects()
                self._json_response({
                    "status": "ok",
                    "workspace": True,
                    "workspacePath": str(CONFIG.dir),
                    "projectCount": len(projects),
                    "projects": projects,
                })
            else:
                info = read_master()
                backups = list_backups()
                self._json_response({
                    "status": "ok",
                    "workspace": False,
                    "lastSave": info.get("meta", {}).get("saved", "") if isinstance(info, dict) else "",
                    "lastBackup": backups[0]["timestamp"] if backups else "",
                    "masterSize": CONFIG.master.stat().st_size if CONFIG.master.exists() else 0,
                    "backupCount": len(backups),
                    "masterPath": str(CONFIG.master),
                    "backupsPath": str(CONFIG.backups_dir),
                })
            return

        if path == "/api/projects" and CONFIG.workspace:
            projects = []
            for name in CONFIG.discover_projects():
                info = read_project_master(name)
                projects.append({
                    "id": name,
                    "name": name,
                    "size": info["size"],
                    "checksum": info["checksum"],
                })
            self._json_response({"projects": projects})
            return

        if path == "/api/registry/projects":
            projects = list_registered_projects()
            self._json_response({"projects": projects, "mode": "registry"})
            return

        if path.startswith("/api/registry/projects/"):
            project_name = path[len("/api/registry/projects/"):]
            info = read_registered_project(project_name)
            if "error" in info:
                self._json_response(info, 404)
                return
            client_checksum = qs.get("checksum", [None])[0]
            if client_checksum and client_checksum == info["checksum"]:
                self.send_response(304)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return
            self._json_response({"content": info["content"], "checksum": info["checksum"]})
            return

        if path.startswith("/api/projects/") and CONFIG.workspace:
            parts = path[len("/api/projects/"):].split("/")
            project_name = parts[0]
            sub_path = "/".join(parts[1:]) if len(parts) > 1 else ""
            
            if sub_path == "backlog" or sub_path == "":
                info = read_project_master(project_name)
                client_checksum = qs.get("checksum", [None])[0]
                if client_checksum and client_checksum == info["checksum"]:
                    self.send_response(304)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    return
                self._json_response({"content": info["content"], "checksum": info["checksum"]})
                return
            
            if sub_path == "backups":
                self._json_response({"backups": list_project_backups(project_name)})
                return
            
            self._json_response({"error": "Not found"}, 404)
            return

        if path == "/api/backlog":
            info = read_master()
            client_checksum = qs.get("checksum", [None])[0]
            if client_checksum and client_checksum == info["checksum"]:
                self.send_response(304)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return
            self._json_response({"content": info["content"], "checksum": info["checksum"]})
            return

        if path == "/api/backups":
            self._json_response({"backups": list_backups()})
            return

        if path.startswith("/api/backups/"):
            name = path[len("/api/backups/"):]
            backup_path = CONFIG.backups_dir / name
            self._file_response(backup_path, "text/markdown")
            return

        if path == "/api/stats":
            events = read_stats(qs.get("from", [None])[0], qs.get("to", [None])[0])
            self._json_response({"events": events})
            return

        self._json_response({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/projects" and CONFIG.workspace:
            body = self._read_json_body()
            name = body.get("name", "")
            result = create_project(name)
            self._json_response(result)
            return

        if path == "/api/registry/register":
            body = self._read_json_body()
            file_path = body.get("path", "")
            name = body.get("name")
            result = register_project(file_path, name)
            self._json_response(result)
            return

        if path == "/api/registry/unregister":
            body = self._read_json_body()
            name = body.get("name", "")
            delete_file = body.get("delete_file", False)
            result = unregister_project(name, delete_file)
            self._json_response(result)
            return

        if path.startswith("/api/registry/projects/"):
            project_name = path[len("/api/registry/projects/"):]
            body = self._read_json_body()
            content = body.get("content", "")
            result = write_registered_project(project_name, content)
            self._json_response(result)
            return

        if path.startswith("/api/projects/") and CONFIG.workspace:
            parts = path[len("/api/projects/"):].split("/")
            project_name = parts[0]
            sub_path = "/".join(parts[1:]) if len(parts) > 1 else ""
            
            if sub_path == "backlog" or sub_path == "":
                body = self._read_json_body()
                content = body.get("content", "")
                result = write_project_master(project_name, content)
                self._json_response(result)
                return
            
            self._json_response({"error": "Not found"}, 404)
            return

        if path == "/api/backlog":
            body = self._read_json_body()
            content = body.get("content", "")
            result = write_master(content)
            self._json_response(result)
            return

        if path == "/api/backups/restore":
            body = self._read_json_body()
            result = restore_backup(body.get("name", ""))
            self._json_response(result)
            return

        if path == "/api/export":
            body = self._read_json_body()
            fmt = body.get("format", "json")
            info = read_master()
            if fmt == "json":
                entries, history, meta = parse_markdown_sections(info["content"])
                self._json_response({
                    "format": "json",
                    "exported_at": datetime.now(timezone.utc).isoformat(),
                    "entries_raw": entries,
                    "history_raw": history,
                    "integrity": meta,
                })
            else:
                self._text_response(info["content"], content_type="text/markdown")
            return

        if path == "/api/import":
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length).decode("utf-8")
            try:
                data = json.loads(raw)
                content = data.get("content", "")
            except json.JSONDecodeError:
                content = raw  # assume markdown
            parse_markdown_sections(content)  # validate readable
            result = write_master(content)
            self._json_response(result)
            return

        if path == "/api/stats":
            body = self._read_json_body()
            append_stats(body)
            self._json_response({"ok": True})
            return

        self._json_response({"error": "Not found"}, 404)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Personal Backlog Server")
    parser.add_argument("--port", type=int, default=8080, help="Port to listen on")
    parser.add_argument("--dir", type=str, default=str(Path(__file__).parent),
                        help="Directory for backlog.md, backups/, stats.jsonl (default: same dir as server.py)")
    parser.add_argument("--web-dir", type=str, default=None, help="Directory to serve static files from (default: webapp/)")
    parser.add_argument("--workspace", action="store_true",
                        help="Multi-project mode: treat --dir as workspace with project subfolders")
    args = parser.parse_args()

    global CONFIG
    web_dir = Path(args.web_dir) if args.web_dir else None
    CONFIG = Config(Path(args.dir), args.port, web_dir, workspace=args.workspace)
    CONFIG.ensure_dirs()

    if args.workspace:
        projects = CONFIG.discover_projects()
        print(f"[init] Workspace mode: {len(projects)} project(s) found")
        for p in projects:
            print(f"       - {p}")
    else:
        if not CONFIG.master.exists():
            blank = build_markdown("", "| Timestamp | Item ID | Action | Details |\n|-----------|---------|--------|---------|")
            CONFIG.master.write_text(blank, encoding="utf-8")
            print(f"[init] Created blank {CONFIG.master}")
        
        auto_register_default_project()

    server = HTTPServer(("0.0.0.0", args.port), Handler)
    print(f"[server] Listening on http://0.0.0.0:{args.port}")
    print(f"[server] Data dir: {CONFIG.dir}")
    print(f"[server] Web dir:  {CONFIG.web_dir}")
    print(f"[server] Mode: {'workspace (multi-project)' if args.workspace else 'single file'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
