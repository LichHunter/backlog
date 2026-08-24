"""Tests for the Personal Backlog server.

stdlib unittest only.

Two layers:
- TestIsolatedServer: startup/registry logic against an isolated tmp dir (todo 1).
- TestLegacyRoutesBaseline: pins the CURRENT legacy HTTP behavior over a real
  HTTPServer thread bound to an ephemeral port. Written BEFORE the per-project
  namespace routes exist — it must stay green through the todo-2 refactor so
  legacy behavior stays byte-identical.
"""

import http.client
import io
import json
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import HTTPServer
from pathlib import Path

import server.server as ss


MINIMAL_MARKDOWN = (
    "# Backlog\n\n"
    "<!-- SECTION: ENTRIES -->\n\n"
    "- [ ] [P1] Alpha item\n\n"
    "<!-- SECTION: HISTORY -->\n\n"
    "| Timestamp | Item ID | Action | Details |\n"
    "|-----------|---------|--------|---------|\n\n"
    "<!-- SECTION: INTEGRITY -->\n\n"
    "<!-- saved: 2025-01-01T00:00:00Z | checksum: sha256:test | entries: 1 | history: 1 -->\n"
)

# Pinned by the web frontend (admin.jsx health card) — must never change silently.
HEALTH_KEYS = {
    "status", "lastSave", "lastBackup", "masterSize", "backupCount",
    "masterPath", "backupsPath", "archiveExists", "archiveSize", "archivePath",
}


def make_content(label: str) -> str:
    return MINIMAL_MARKDOWN.replace("Alpha item", f"{label} item")


class TestIsolatedServer(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._orig_config = ss.CONFIG
        ss.CONFIG = ss.Config(Path(self.tmp.name), 8080)
        ss.CONFIG.ensure_dirs()

    def tearDown(self):
        ss.CONFIG = self._orig_config

    # (1) fresh dir -> startup registers exactly the default project
    def test_initialize_storage_registers_default_on_fresh_dir(self):
        ss.initialize_storage()
        registry_path = ss.CONFIG.registry_file
        self.assertTrue(registry_path.exists(), "projects.json must exist after startup")
        with open(registry_path, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(
            data,
            {"default": {"path": str(ss.CONFIG.master.resolve()), "name": "default"}},
        )

    # (2) registry with existing entries -> auto_register_default is a no-op
    def test_auto_register_default_noop_when_registry_has_entries(self):
        existing = {"work": {"path": "/somewhere/work/backlog.md", "name": "work"}}
        ss.CONFIG.save_registry(existing)
        ss.auto_register_default()
        with open(ss.CONFIG.registry_file, encoding="utf-8") as f:
            data = json.load(f)
        self.assertEqual(data, existing)

    # (3) corrupt projects.json -> load_registry returns {} without raising
    def test_load_registry_corrupt_file_returns_empty(self):
        ss.CONFIG.registry_file.write_text("{bad", encoding="utf-8")
        captured = io.StringIO()
        with redirect_stdout(captured):
            result = ss.CONFIG.load_registry()
        self.assertEqual(result, {})
        self.assertIn("[registry] projects.json unreadable", captured.getvalue())

    # (4) safe_project_name sanitizes and rejects empty
    def test_safe_project_name(self):
        self.assertEqual(ss.safe_project_name("My Proj!"), "My-Proj-")
        self.assertEqual(ss.safe_project_name("  "), "")

    # (5) save_registry -> load_registry roundtrip preserves the dict
    def test_registry_roundtrip_preserves_dict(self):
        registry = {
            "default": {"path": "/data/backlog.md", "name": "default"},
            "work": {"path": "/home/me/work/backlog.md", "name": "work"},
        }
        ss.CONFIG.save_registry(registry)
        self.assertEqual(ss.CONFIG.load_registry(), registry)

    # (6) get_project_path resolves registered paths, KeyError otherwise
    def test_get_project_path(self):
        master = ss.CONFIG.master.resolve()
        ss.CONFIG.save_registry({"default": {"path": str(master), "name": "default"}})
        self.assertEqual(ss.get_project_path("default"), master)
        with self.assertRaises(KeyError):
            ss.get_project_path("nope")


class TestLegacyRoutesBaseline(unittest.TestCase):
    """Pins legacy single-project HTTP behavior (must hold before AND after todo 2)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._orig_config = ss.CONFIG
        ss.CONFIG = ss.Config(Path(self.tmp.name), 0)
        ss.initialize_storage()
        self.httpd = HTTPServer(("127.0.0.1", 0), ss.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        # LIFO: shutdown the loop, then close the socket, then restore CONFIG.
        self.addCleanup(setattr, ss, "CONFIG", self._orig_config)
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def request(self, method: str, path: str, json_body=None, raw_body=None):
        """One HTTP request → (status, decoded text). json_body dict or raw_body str."""
        if raw_body is not None:
            payload = raw_body.encode("utf-8")
        elif json_body is not None:
            payload = json.dumps(json_body).encode("utf-8")
        else:
            payload = None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data.decode("utf-8")

    def request_json(self, method: str, path: str, json_body=None, raw_body=None):
        status, text = self.request(method, path, json_body=json_body, raw_body=raw_body)
        return status, json.loads(text)

    # GET /api/backlog on a never-written fresh server → blank template
    def test_get_backlog_fresh_returns_blank_template(self):
        status, data = self.request_json("GET", "/api/backlog")
        self.assertEqual(status, 200)
        self.assertEqual(set(data.keys()), {"content", "checksum"})
        self.assertIn("# Backlog", data["content"])
        self.assertIn("<!-- SECTION: ENTRIES -->", data["content"])
        self.assertIn("| Timestamp | Item ID | Action | Details |", data["content"])
        self.assertTrue(data["checksum"].startswith("sha256:"))

    # POST then GET roundtrip returns the written content with its checksum
    def test_post_backlog_roundtrip(self):
        status, resp = self.request_json("POST", "/api/backlog", json_body={"content": MINIMAL_MARKDOWN})
        self.assertEqual(status, 200)
        self.assertTrue(resp["ok"])
        status, data = self.request_json("GET", "/api/backlog")
        self.assertEqual(status, 200)
        self.assertEqual(data["content"], MINIMAL_MARKDOWN)
        self.assertEqual(data["checksum"], resp["checksum"])

    # Matching ?checksum= → 304 Not Modified (polled by the web SyncPoller)
    def test_get_backlog_304_on_matching_checksum(self):
        _, data = self.request_json("GET", "/api/backlog")
        status, _text = self.request("GET", f"/api/backlog?checksum={data['checksum']}")
        self.assertEqual(status, 304)

    # GET unknown API route → 404 JSON error
    def test_get_unknown_api_route_404(self):
        status, data = self.request_json("GET", "/api/nope")
        self.assertEqual(status, 404)
        self.assertIn("error", data)

    # /api/health key set is pinned EXACTLY (web consumes these keys)
    def test_health_shape_pinned(self):
        status, data = self.request_json("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(set(data.keys()), HEALTH_KEYS)

    # Fresh archive is reported as absent
    def test_get_archive_fresh_absent(self):
        status, data = self.request_json("GET", "/api/archive")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"content": "", "checksum": "", "exists": False})

    # Fresh backups listing is empty
    def test_get_backups_fresh_empty(self):
        status, data = self.request_json("GET", "/api/backups")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"backups": []})


class TestProjectNamespace(unittest.TestCase):
    """Todo 2: /api/projects namespace + legacy aliases (failing-first)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._orig_config = ss.CONFIG
        ss.CONFIG = ss.Config(Path(self.tmp.name), 0)
        ss.initialize_storage()
        self.httpd = HTTPServer(("127.0.0.1", 0), ss.Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(setattr, ss, "CONFIG", self._orig_config)
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def request(self, method: str, path: str, json_body=None, raw_body=None):
        if raw_body is not None:
            payload = raw_body.encode("utf-8")
        elif json_body is not None:
            payload = json.dumps(json_body).encode("utf-8")
        else:
            payload = None
        headers = {"Content-Type": "application/json"} if payload is not None else {}
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request(method, path, body=payload, headers=headers)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data.decode("utf-8")

    def request_json(self, method: str, path: str, json_body=None, raw_body=None):
        status, text = self.request(method, path, json_body=json_body, raw_body=raw_body)
        return status, json.loads(text)

    def register_project(self, name: str, master: Path, content: str):
        master.write_text(content, encoding="utf-8")
        registry = ss.CONFIG.load_registry()
        registry[name] = {"path": str(master), "name": name}
        ss.CONFIG.save_registry(registry)

    # (a) legacy GET /api/backlog body == GET /api/projects/default/backlog body
    def test_legacy_backlog_equals_default_project_backlog(self):
        _, legacy = self.request_json("GET", "/api/backlog")
        status, namespaced = self.request_json("GET", "/api/projects/default/backlog")
        self.assertEqual(status, 200)
        self.assertEqual(legacy, namespaced)

    # (b) POST then GET roundtrip on the namespace route
    def test_project_backlog_roundtrip_default(self):
        content = make_content("namespaced")
        status, resp = self.request_json("POST", "/api/projects/default/backlog",
                                         json_body={"content": content})
        self.assertEqual(status, 200)
        self.assertTrue(resp["ok"])
        self.assertTrue(resp["checksum"])
        status, data = self.request_json("GET", "/api/projects/default/backlog")
        self.assertEqual(status, 200)
        self.assertEqual(data["content"], content)
        self.assertEqual(data["checksum"], resp["checksum"])

    # (c) unknown project → 404 {"error": "Project not found"} on GET and POST
    def test_unknown_project_404(self):
        status, data = self.request_json("GET", "/api/projects/nope/backlog")
        self.assertEqual(status, 404)
        self.assertEqual(data, {"error": "Project not found"})
        status, data = self.request_json("POST", "/api/projects/nope/backlog",
                                         json_body={"content": MINIMAL_MARKDOWN})
        self.assertEqual(status, 404)
        self.assertEqual(data, {"error": "Project not found"})

    # (e) two extra registered projects: listing + strict write isolation
    def test_projects_listing_and_write_isolation(self):
        tmp_a = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_a.cleanup)
        tmp_b = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_b.cleanup)
        alpha = Path(tmp_a.name) / "backlog.md"
        beta = Path(tmp_b.name) / "backlog.md"
        self.register_project("alpha", alpha, make_content("alpha-original"))
        self.register_project("beta", beta, make_content("beta-original"))

        status, data = self.request_json("GET", "/api/projects")
        self.assertEqual(status, 200)
        self.assertEqual([p["name"] for p in data["projects"]], ["default", "alpha", "beta"])
        alpha_entry = data["projects"][1]
        self.assertEqual(alpha_entry["path"], str(alpha))
        self.assertEqual(alpha_entry["size"], alpha.stat().st_size)
        self.assertTrue(alpha_entry["checksum"].startswith("sha256:"))
        self.assertFalse(alpha_entry["missing"])

        default_before = ss.CONFIG.master.read_bytes()
        beta_before = beta.read_bytes()
        rewritten = make_content("alpha-rewritten")
        status, resp = self.request_json("POST", "/api/projects/alpha/backlog",
                                         json_body={"content": rewritten})
        self.assertEqual(status, 200)
        self.assertTrue(resp["ok"])

        # Isolation: only alpha's file changed.
        self.assertEqual(alpha.read_text(encoding="utf-8"), rewritten)
        self.assertEqual(ss.CONFIG.master.read_bytes(), default_before)
        self.assertEqual(beta.read_bytes(), beta_before)

        # alpha's backups live under alpha's own directory, and are listed.
        backups_dir = Path(tmp_a.name) / "backups"
        self.assertTrue(backups_dir.is_dir())
        self.assertTrue(any(backups_dir.glob("backlog_*.md")))
        status, data = self.request_json("GET", "/api/projects/alpha/backups")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(len(data["backups"]), 1)
        self.assertEqual(list(ss.CONFIG.backups_dir.glob("backlog_*.md")), [])

    # Per-project archive dual-write: both files land next to the project file
    def test_per_project_archive_dual_write(self):
        tmp_a = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_a.cleanup)
        alpha = Path(tmp_a.name) / "backlog.md"
        self.register_project("alpha", alpha, make_content("alpha-original"))

        backlog_content = make_content("after-archive")
        archive_content = MINIMAL_MARKDOWN.replace("Alpha item", "archived item")
        status, resp = self.request_json("POST", "/api/projects/alpha/archive",
                                         json_body={"backlog": backlog_content,
                                                    "archive": archive_content})
        self.assertEqual(status, 200)
        self.assertTrue(resp["ok"])
        self.assertTrue(resp["backlog"]["ok"])
        self.assertTrue(resp["archive"]["ok"])
        self.assertEqual(alpha.read_text(encoding="utf-8"), backlog_content)
        self.assertEqual((Path(tmp_a.name) / "archive.md").read_text(encoding="utf-8"),
                         archive_content)
        # default project untouched
        self.assertFalse(ss.CONFIG.archive.exists())

        status, data = self.request_json("GET", "/api/projects/alpha/archive")
        self.assertEqual(status, 200)
        self.assertEqual(data["exists"], True)
        self.assertEqual(data["content"], archive_content)

    # Per-project backup restore puts the chosen backup back into the project file
    def test_per_project_backup_restore(self):
        tmp_a = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_a.cleanup)
        alpha = Path(tmp_a.name) / "backlog.md"
        first = make_content("first")
        second = make_content("second")
        self.register_project("alpha", alpha, make_content("seed"))
        status, resp = self.request_json("POST", "/api/projects/alpha/backlog",
                                         json_body={"content": first})
        self.assertTrue(resp["ok"])
        status, resp = self.request_json("POST", "/api/projects/alpha/backlog",
                                         json_body={"content": second})
        self.assertTrue(resp["ok"])

        status, data = self.request_json("GET", "/api/projects/alpha/backups")
        self.assertEqual(status, 200)
        names = [b["name"] for b in data["backups"]]  # newest first
        self.assertEqual(len(names), 2)

        status, resp = self.request_json("POST", "/api/projects/alpha/backups/restore",
                                         json_body={"name": names[-1]})  # oldest
        self.assertEqual(status, 200)
        self.assertTrue(resp["ok"])
        self.assertEqual(alpha.read_text(encoding="utf-8"), first)

    # (f) rename default → main: legacy routes alias the first registry entry
    def test_first_entry_alias_after_default_rename(self):
        content = make_content("alias-target")
        status, resp = self.request_json("POST", "/api/backlog", json_body={"content": content})
        self.assertTrue(resp["ok"])
        master = ss.CONFIG.master
        ss.CONFIG.save_registry({"main": {"path": str(master), "name": "main"}})

        status, data = self.request_json("GET", "/api/backlog")
        self.assertEqual(status, 200)
        self.assertEqual(data["content"], content)

        status, namespaced = self.request_json("GET", "/api/projects/main/backlog")
        self.assertEqual(status, 200)
        self.assertEqual(namespaced, data)

        # health keeps its exact shape and still describes the aliased project
        status, health = self.request_json("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(set(health.keys()), HEALTH_KEYS)
        self.assertEqual(health["masterPath"], str(master))

    # Adversarial: malformed JSON body on a namespace POST → graceful 400, server stays up
    def test_post_project_backlog_invalid_json_400(self):
        status, data = self.request_json("POST", "/api/projects/default/backlog",
                                         raw_body='{"content": not-json')
        self.assertEqual(status, 400)
        self.assertIn("error", data)
        # server still alive afterwards
        status, _ = self.request("GET", "/api/backlog")
        self.assertEqual(status, 200)

    # Adversarial: empty project name → 404
    def test_empty_project_name_404(self):
        status, _ = self.request("GET", "/api/projects/")
        self.assertEqual(status, 404)
        status, _ = self.request("GET", "/api/projects//backlog")
        self.assertEqual(status, 404)
        status, _ = self.request("POST", "/api/projects//backlog",
                                 json_body={"content": MINIMAL_MARKDOWN})
        self.assertEqual(status, 404)

    # Registry edits on disk are picked up by the NEXT request (no caching)
    def test_registry_reload_between_requests(self):
        tmp_a = tempfile.TemporaryDirectory()
        self.addCleanup(tmp_a.cleanup)
        alpha = Path(tmp_a.name) / "backlog.md"
        status, _ = self.request("GET", "/api/projects/alpha/backlog")
        self.assertEqual(status, 404)
        self.register_project("alpha", alpha, make_content("late-registered"))
        status, data = self.request_json("GET", "/api/projects/alpha/backlog")
        self.assertEqual(status, 200)
        self.assertEqual(data["content"], make_content("late-registered"))


if __name__ == "__main__":
    unittest.main()
