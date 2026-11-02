- Changelog entries go in `changelog.d/<name>.<section>.md` instead of `CHANGELOG.md`, so parallel pull requests stop
  conflicting on it. `.github/scripts/changelog-assemble.py <version>` folds them in before a tag (`--check` validates
  them; CI runs it), and the release workflow refuses a tag while fragments remain. See `changelog.d/README.md`.
