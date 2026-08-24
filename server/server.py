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
from typing import NamedTuple
from urllib.parse import parse_qs, urlparse, unquote


class Config:
    def __init__(self, directory: Path, port: int, web_dir: Path | None = None):
        self.dir = directory.resolve()
        self.port = port
        self.master = self.dir / "backlog.md"
        self.archive = self.dir / "archive.md"
        self.backups_dir = self.dir / "backups"
        self.stats_file = self.dir / "stats.jsonl"
        self.registry_file = self.dir / "projects.json"
        self.web_dir = web_dir.resolve() if web_dir else Path(__file__).parent.parent / "webapp"

    def ensure_dirs(self):
        self.dir.mkdir(parents=True, exist_ok=True)
        self.backups_dir.mkdir(exist_ok=True)

    def load_registry(self) -> dict:
        if not self.registry_file.exists():
            return {}
        try:
            return json.loads(self.registry_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            print(f"[registry] projects.json unreadable, starting empty: {e}")
            return {}

    def save_registry(self, registry: dict):
        tmp = self.registry_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(registry, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.registry_file)


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
# Path-parameterized cores (*_at) serve any project; the bare-name wrappers
# keep the legacy single-project API bound to the resolved default project.

BLANK_HISTORY = "| Timestamp | Item ID | Action | Details |\n|-----------|---------|--------|---------|"


class ProjectPaths(NamedTuple):
    master: Path
    archive: Path
    backups_dir: Path


def read_master_at(master: Path) -> dict:
    if not master.exists():
        return {"content": build_markdown("", BLANK_HISTORY), "checksum": "", "size": 0}
    text = master.read_text(encoding="utf-8")
    _, _, meta = parse_markdown_sections(text)
    checksum = meta["checksum"] if meta else ""
    return {"content": text, "checksum": checksum, "size": len(text.encode("utf-8"))}


def write_master_at(content: str, paths: ProjectPaths) -> dict:
    """Atomic write with backup. Creates the project's parent/backups dirs on demand."""
    paths.master.parent.mkdir(parents=True, exist_ok=True)
    tmp = paths.master.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    parse_markdown_sections(content)  # verify it parses
    # Create backup (millis to avoid collisions)
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    millis = datetime.now(timezone.utc).strftime("%f")[:3]
    backup_name = f"backlog_{timestamp}-{millis}.md"
    paths.backups_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(tmp, paths.backups_dir / backup_name)
    rotate_backups_at(paths.backups_dir)
    # Atomic rename
    tmp.replace(paths.master)
    # Stats stay global (single analytics log in the data dir)
    append_stats({"t": datetime.now(timezone.utc).isoformat(), "e": "save_completed", "d": {"size": len(content.encode("utf-8"))}})
    _, _, meta = parse_markdown_sections(content)
    return {"ok": True, "checksum": meta["checksum"] if meta else "", "saved": meta["saved"] if meta else ""}


def read_archive_at(archive: Path) -> dict:
    """Read archive.md, return empty structure if not exists."""
    if not archive.exists():
        return {"content": "", "checksum": "", "size": 0, "exists": False}
    text = archive.read_text(encoding="utf-8")
    _, _, meta = parse_markdown_sections(text)
    checksum = meta["checksum"] if meta else ""
    return {"content": text, "checksum": checksum, "size": len(text.encode("utf-8")), "exists": True}


def write_archive_at(content: str, paths: ProjectPaths) -> dict:
    """Write archive.md (append-only semantics enforced at API level)."""
    paths.archive.parent.mkdir(parents=True, exist_ok=True)
    tmp = paths.archive.with_suffix(".md.tmp")
    tmp.write_text(content, encoding="utf-8")
    parse_markdown_sections(content)  # verify it parses
    tmp.replace(paths.archive)
    _, _, meta = parse_markdown_sections(content)
    return {"ok": True, "checksum": meta["checksum"] if meta else "", "saved": meta["saved"] if meta else ""}


def rotate_backups_at(backups_dir: Path):
    files = sorted(backups_dir.glob("backlog_*.md"), key=lambda p: p.stat().st_mtime)
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


def list_backups_at(backups_dir: Path) -> list:
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


def restore_backup_at(name: str, paths: ProjectPaths) -> dict:
    src = paths.backups_dir / name
    if not src.exists():
        return {"ok": False, "error": "Backup not found"}
    text = src.read_text(encoding="utf-8")
    parse_markdown_sections(text)  # validate readable
    paths.master.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, paths.master)
    return {"ok": True}


def read_master() -> dict:
    return read_master_at(resolve_default_project().master)


def write_master(content: str) -> dict:
    return write_master_at(content, resolve_default_project())


def read_archive() -> dict:
    return read_archive_at(resolve_default_project().archive)


def write_archive(content: str) -> dict:
    return write_archive_at(content, resolve_default_project())


def rotate_backups():
    rotate_backups_at(resolve_default_project().backups_dir)


def list_backups() -> list:
    return list_backups_at(resolve_default_project().backups_dir)


def restore_backup(name: str) -> dict:
    return restore_backup_at(name, resolve_default_project())


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
# Project registry
# ---------------------------------------------------------------------------

def safe_project_name(name: str) -> str:
    """Collapse to [a-zA-Z0-9_-]; empty result means the name is invalid."""
    return re.sub(r"[^a-zA-Z0-9_-]", "-", name.strip())


def get_project_path(name: str) -> Path:
    registry = CONFIG.load_registry()
    if name not in registry:
        raise KeyError(name)
    return Path(registry[name]["path"]).resolve()


def project_paths(name: str) -> ProjectPaths:
    """Paths for a registered project; KeyError when the name is unknown."""
    master = get_project_path(name)
    return ProjectPaths(master=master, archive=master.parent / "archive.md", backups_dir=master.parent / "backups")


def resolve_default_project_name() -> str:
    """'default' when registered, else the first registry entry (insertion order)."""
    registry = CONFIG.load_registry()
    if "default" in registry:
        return "default"
    return next(iter(registry), "default")


def resolve_default_project() -> ProjectPaths:
    """Paths legacy routes operate on; CONFIG paths when the registry is empty/corrupt."""
    try:
        return project_paths(resolve_default_project_name())
    except KeyError:
        return ProjectPaths(master=CONFIG.master, archive=CONFIG.archive, backups_dir=CONFIG.backups_dir)


def list_projects() -> list:
    """Summary entries for GET /api/projects, in registry insertion order."""
    projects = []
    for name, entry in CONFIG.load_registry().items():
        master = Path(entry["path"]).resolve()
        missing = not master.exists()
        checksum = ""
        size = 0
        if not missing:
            size = master.stat().st_size
            _, _, meta = parse_markdown_sections(master.read_text(encoding="utf-8"))
            if meta:
                checksum = meta["checksum"]
        projects.append({"name": name, "path": str(master), "size": size, "checksum": checksum, "missing": missing})
    return projects


def auto_register_default():
    registry = CONFIG.load_registry()
    if registry:
        return
    if not CONFIG.master.exists():
        return
    path = str(CONFIG.master.resolve())
    registry["default"] = {"path": path, "name": "default"}
    CONFIG.save_registry(registry)
    print(f"[init] Registered default project: {path}")


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

    def _read_json_body_or_400(self):
        """Parsed JSON body, or None after responding 400 to malformed JSON."""
        try:
            return self._read_json_body()
        except json.JSONDecodeError as e:
            self._json_response({"error": f"Invalid JSON: {e}"}, 400)
            return None

    def _project_route_parts(self, path: str) -> tuple:
        """'/api/projects/<name>[/<action>...]' → (url-decoded name, action)."""
        rest = path[len("/api/projects/"):]
        name, _, action = rest.partition("/")
        return unquote(name), action

    def _resolve_project_or_404(self, name: str):
        """ProjectPaths for name, or None after responding 404 (empty/unknown)."""
        try:
            if name:
                return project_paths(name)
        except KeyError:
            pass
        self._json_response({"error": "Project not found"}, 404)
        return None

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

        if path == "/api/projects":
            self._json_response({"projects": list_projects()})
            return

        if path.startswith("/api/projects/"):
            name, action = self._project_route_parts(path)
            paths = self._resolve_project_or_404(name)
            if paths is None:
                return
            if action == "backlog":
                info = read_master_at(paths.master)
                client_checksum = qs.get("checksum", [None])[0]
                if client_checksum and client_checksum == info["checksum"]:
                    self.send_response(304)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    return
                self._json_response({"content": info["content"], "checksum": info["checksum"]})
                return
            if action == "archive":
                info = read_archive_at(paths.archive)
                if not info["exists"]:
                    self._json_response({"content": "", "checksum": "", "exists": False})
                    return
                client_checksum = qs.get("checksum", [None])[0]
                if client_checksum and client_checksum == info["checksum"]:
                    self.send_response(304)
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    return
                self._json_response({"content": info["content"], "checksum": info["checksum"], "exists": True})
                return
            if action == "backups":
                self._json_response({"backups": list_backups_at(paths.backups_dir)})
                return
            self._json_response({"error": "Not found"}, 404)
            return

        if path == "/api/health":
            paths = resolve_default_project()
            info = read_master_at(paths.master)
            archive_info = read_archive_at(paths.archive)
            backups = list_backups_at(paths.backups_dir)
            self._json_response({
                "status": "ok",
                "lastSave": info.get("meta", {}).get("saved", "") if isinstance(info, dict) else "",
                "lastBackup": backups[0]["timestamp"] if backups else "",
                "masterSize": paths.master.stat().st_size if paths.master.exists() else 0,
                "backupCount": len(backups),
                "masterPath": str(paths.master),
                "backupsPath": str(paths.backups_dir),
                "archiveExists": archive_info["exists"],
                "archiveSize": archive_info["size"],
                "archivePath": str(paths.archive),
            })
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

        if path == "/api/archive":
            info = read_archive()
            if not info["exists"]:
                self._json_response({"content": "", "checksum": "", "exists": False})
                return
            client_checksum = qs.get("checksum", [None])[0]
            if client_checksum and client_checksum == info["checksum"]:
                self.send_response(304)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                return
            self._json_response({"content": info["content"], "checksum": info["checksum"], "exists": True})
            return

        if path == "/api/backups":
            self._json_response({"backups": list_backups()})
            return

        if path.startswith("/api/backups/"):
            name = path[len("/api/backups/"):]
            backup_path = resolve_default_project().backups_dir / name
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

        if path.startswith("/api/projects/"):
            name, action = self._project_route_parts(path)
            body = self._read_json_body_or_400()
            if body is None:
                return
            paths = self._resolve_project_or_404(name)
            if paths is None:
                return
            if action == "backlog":
                result = write_master_at(body.get("content", ""), paths)
                self._json_response(result)
                return
            if action == "archive":
                # Archive items: save both backlog and archive atomically
                backlog_content = body.get("backlog", "")
                archive_content = body.get("archive", "")
                parse_markdown_sections(backlog_content)
                parse_markdown_sections(archive_content)
                # Write archive first (append-only), then backlog
                archive_result = write_archive_at(archive_content, paths)
                backlog_result = write_master_at(backlog_content, paths)
                self._json_response({"ok": True, "backlog": backlog_result, "archive": archive_result})
                return
            if action == "archive/restore":
                # Restore items from archive: save both backlog and archive atomically
                backlog_content = body.get("backlog", "")
                archive_content = body.get("archive", "")
                parse_markdown_sections(backlog_content)
                parse_markdown_sections(archive_content)
                backlog_result = write_master_at(backlog_content, paths)
                archive_result = write_archive_at(archive_content, paths)
                self._json_response({"ok": True, "backlog": backlog_result, "archive": archive_result})
                return
            if action == "backups/restore":
                result = restore_backup_at(body.get("name", ""), paths)
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

        if path == "/api/archive":
            # Archive items: save both backlog and archive atomically
            body = self._read_json_body()
            backlog_content = body.get("backlog", "")
            archive_content = body.get("archive", "")
            # Validate both parse correctly
            parse_markdown_sections(backlog_content)
            parse_markdown_sections(archive_content)
            # Write archive first (append-only), then backlog
            archive_result = write_archive(archive_content)
            backlog_result = write_master(backlog_content)
            self._json_response({"ok": True, "backlog": backlog_result, "archive": archive_result})
            return

        if path == "/api/archive/restore":
            # Restore items from archive: save both backlog and archive atomically
            body = self._read_json_body()
            backlog_content = body.get("backlog", "")
            archive_content = body.get("archive", "")
            parse_markdown_sections(backlog_content)
            parse_markdown_sections(archive_content)
            backlog_result = write_master(backlog_content)
            archive_result = write_archive(archive_content)
            self._json_response({"ok": True, "backlog": backlog_result, "archive": archive_result})
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

def initialize_storage():
    CONFIG.ensure_dirs()
    if not CONFIG.master.exists():
        CONFIG.master.write_text(build_markdown("", BLANK_HISTORY), encoding="utf-8")
        print(f"[init] Created blank {CONFIG.master}")
    auto_register_default()


def main():
    parser = argparse.ArgumentParser(description="Personal Backlog Server")
    parser.add_argument("--port", type=int, default=8080, help="Port to listen on")
    parser.add_argument("--dir", type=str, default=str(Path(__file__).parent),
                        help="Directory for backlog.md, backups/, stats.jsonl (default: same dir as server.py)")
    parser.add_argument("--web-dir", type=str, default=None, help="Directory to serve static files from (default: webapp/)")
    args = parser.parse_args()

    global CONFIG
    web_dir = Path(args.web_dir) if args.web_dir else None
    CONFIG = Config(Path(args.dir), args.port, web_dir)
    initialize_storage()

    server = HTTPServer(("0.0.0.0", args.port), Handler)
    print(f"[server] Listening on http://0.0.0.0:{args.port}")
    print(f"[server] Data dir: {CONFIG.dir}")
    print(f"[server] Web dir:  {CONFIG.web_dir}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
