from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from smolagents_worker.project_scan import scan_project


class ProjectScanTest(unittest.TestCase):
    def test_scan_project_respects_includes_and_skips_heavy_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_text("# Demo\nhello\n", encoding="utf-8")
            (root / "src").mkdir()
            (root / "src" / "main.ts").write_text("export const x = 1;\n", encoding="utf-8")
            (root / "node_modules").mkdir()
            (root / "node_modules" / "ignored.ts").write_text("ignored\n", encoding="utf-8")
            (root / "notes.txt").write_text("ignored\n", encoding="utf-8")

            inventory = scan_project(str(root), max_files=10)

            self.assertEqual([item.path for item in inventory.files], ["README.md", "src/main.ts"])
            self.assertEqual(inventory.files[0].first_heading, "# Demo")
            self.assertGreaterEqual(inventory.skipped_count, 2)

    def test_scan_project_truncates_large_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "README.md").write_text("# Demo\n" + "x" * 100, encoding="utf-8")

            inventory = scan_project(str(root), max_bytes_per_file=10)

            self.assertEqual(len(inventory.files), 1)
            self.assertTrue(inventory.files[0].truncated)
            self.assertEqual(inventory.files[0].bytes_read, 10)


if __name__ == "__main__":
    unittest.main()
