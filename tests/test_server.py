"""Tests for the Personal Backlog server (registry core, todo 1).

stdlib unittest only. Runs the server's startup logic (initialize_storage /
auto_register_default) against an isolated temporary data dir — no port is
bound, no serve_forever loop is started.
"""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import server.server as ss


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


if __name__ == "__main__":
    unittest.main()
