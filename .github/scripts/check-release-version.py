#!/usr/bin/env python3
"""Check that every version in the tree matches a release tag.

Usage: check-release-version.py v0.1.0, from the root of the tree to check.

The images are tagged from the git tag and the packages from their own files,
so a missed bump ships a release whose parts name different versions. This runs
before anything is published, and on every pull request against the tree's own
version.
"""

import json
import re
import sys
import tomllib
from pathlib import Path

REPO = Path.cwd()

VERSION = r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*?)?"
END = r"(?![0-9A-Za-z.-])"

# Places the README names a released version.
DOC_PINS = [
    re.compile(rf"releases/download/v({VERSION})/"),
    re.compile(rf"felix-metro-compose-({VERSION})(?:\.tar\.gz|{END})"),
]


def found_versions() -> list[tuple[str, str | None]]:
    out: list[tuple[str, str | None]] = []
    for crate in ("core", "sim"):
        manifest = tomllib.loads((REPO / crate / "Cargo.toml").read_text(encoding="utf-8"))
        out.append((f"{crate}/Cargo.toml", manifest["package"]["version"]))
    lock = tomllib.loads((REPO / "Cargo.lock").read_text(encoding="utf-8"))
    for package in lock["package"]:
        if package["name"] in ("felix-metro-core", "felix-metro-sim"):
            out.append((f"Cargo.lock {package['name']}", package["version"]))
    out.append(("web/package.json", json.loads((REPO / "web/package.json").read_text())["version"]))
    web_lock = json.loads((REPO / "web/package-lock.json").read_text())
    out.append(("web/package-lock.json", web_lock["version"]))
    out.append(("web/package-lock.json root package", web_lock["packages"][""]["version"]))
    readme = (REPO / "README.md").read_text(encoding="utf-8")
    for pin in DOC_PINS:
        for match in pin.finditer(readme):
            out.append((f"README.md {match.group(0)}", match.group(1)))
    return out


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check-release-version.py <tag>", file=sys.stderr)
        return 2
    tag = sys.argv[1]
    if not re.fullmatch(rf"v{VERSION}", tag):
        print(f"{tag} is not a version tag such as v0.1.0", file=sys.stderr)
        return 1
    want = tag.removeprefix("v")
    bad = [(where, got) for where, got in found_versions() if got != want]
    for where, got in bad:
        print(f"::error::{where} is {got}, the tag is {want}")
    if bad:
        return 1
    print(f"every version in the tree is {want}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
