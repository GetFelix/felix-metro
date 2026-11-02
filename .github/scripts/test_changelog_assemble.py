#!/usr/bin/env python3
"""Tests for changelog-assemble.py. Run: python3 .github/scripts/test_changelog_assemble.py"""

import importlib.util
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("changelog_assemble", HERE / "changelog-assemble.py")
ca = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ca)

CHANGELOG = """# Changelog

## [Unreleased]

### The sim

- hand-written sim

### Added

- hand-written add

### The city

- hand-written city

## [0.1.0] - 2026-01-01

### Added

- old
"""


def headings(text):
    return [line for line in text.splitlines() if line.startswith("#")]


class Assemble(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        ca.CHANGELOG = root / "CHANGELOG.md"
        ca.FRAGMENT_DIR = root / "changelog.d"
        ca.FRAGMENT_DIR.mkdir()
        ca.CHANGELOG.write_text(CHANGELOG)

    def tearDown(self):
        self.tmp.cleanup()

    def frag(self, name, body):
        (ca.FRAGMENT_DIR / name).write_text(body)

    def test_merges_in_fixed_order_and_deletes(self):
        self.frag("2-b.fixed.md", "- fix b\n")
        self.frag("1-a.fixed.md", "- fix a\n")
        self.frag("3-t.tools.md", "- tool\n")
        self.frag("4-p.page.md", "- page\n")
        self.frag("5-s.sim.md", "- sim\n")
        self.frag("README.md", "ignored")
        self.assertEqual(ca.assemble("1.0.0", "2026-02-02"), 0)
        text = ca.CHANGELOG.read_text()
        self.assertIn("## [Unreleased]\n\n## [1.0.0] - 2026-02-02\n\n### The sim\n", text)
        released = text.split("## [1.0.0]")[1].split("## [0.1.0]")[0]
        self.assertEqual(
            headings(released),
            ["### The sim", "### Added", "### Fixed", "### The page", "### Tools", "### The city"],
        )
        # Fragments append to a heading that already has entries, sorted by file name.
        self.assertLess(released.index("hand-written sim"), released.index("- sim"))
        self.assertLess(released.index("fix a"), released.index("fix b"))
        self.assertIn("### Added\n\n- hand-written add\n", released)
        self.assertEqual(text.count("### Added"), 2)
        self.assertEqual([p.name for p in ca.fragment_files(ca.FRAGMENT_DIR)], [])
        self.assertTrue((ca.FRAGMENT_DIR / "README.md").exists())
        self.assertTrue(text.endswith("### Added\n\n- old\n"))

    def test_without_unreleased_entries(self):
        ca.CHANGELOG.write_text("# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Fixed\n\n- old\n")
        self.assertEqual(ca.assemble("0.2.0", "2026-02-02"), 1)
        self.frag("1.changed.md", "- new\n")
        self.assertEqual(ca.assemble("0.2.0", "2026-02-02"), 0)
        self.assertEqual(
            ca.CHANGELOG.read_text(),
            "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-02-02\n\n### Changed\n\n- new\n\n"
            "## [0.1.0] - 2026-01-01\n\n### Fixed\n\n- old\n",
        )

    def test_release_notes_still_extract(self):
        self.frag("1.fixed.md", "- fixed it\n")
        self.assertEqual(ca.assemble("1.0.0", "2026-02-02"), 0)
        notes = subprocess.run(
            [sys.executable, str(HERE / "changelog-section.py"), "v1.0.0", str(ca.CHANGELOG)],
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        self.assertIn("- fixed it", notes)
        self.assertIn("- hand-written sim", notes)
        self.assertNotIn("- old", notes)

    def test_refuses_a_version_already_released(self):
        self.frag("1.fixed.md", "- x\n")
        self.assertEqual(ca.assemble("0.1.0", "2026-02-02"), 1)
        self.assertTrue((ca.FRAGMENT_DIR / "1.fixed.md").exists())

    def test_check_rejects_bad_fragments(self):
        self.assertEqual(ca.check(), 0)
        self.frag("x.bogus.md", "- y")
        self.frag("e.added.md", "  \n")
        self.frag("noext.md", "- y")
        self.frag("h.fixed.md", "- y\n## Oops")
        self.frag("ok.fixed.md", "- y\n  ## indented is fine")
        _, errors = ca.load_fragments(ca.FRAGMENT_DIR)
        self.assertEqual(len(errors), 4)
        self.assertEqual(ca.check(), 1)


if __name__ == "__main__":
    unittest.main()
