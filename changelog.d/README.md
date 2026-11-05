# Changelog fragments

Add one file here per change instead of editing `CHANGELOG.md`. Parallel pull requests
that edit the same section conflict; separate files do not.

## Naming

`changelog.d/<name>.<section>.md`

- `<name>` is free. Use the issue or PR number and a slug: `142-attribution`.
- `<section>` picks the heading the entry lands under:

  | Slug      | Heading in `CHANGELOG.md` |
  | --------- | ------------------------- |
  | `sim`     | The sim                   |
  | `added`   | Added                     |
  | `changed` | Changed                   |
  | `fixed`   | Fixed                     |
  | `page`    | The page                  |
  | `tools`   | Tools                     |

A change that belongs under two headings gets two files.

## Body

Markdown bullets, written exactly as they should read under the heading, in the
style of the entries already in `CHANGELOG.md`. No headings: the file name sets the
section, and the check refuses a `#`, `##` or `###` line.

`changelog.d/142-attribution.sim.md`:

```markdown
- Every event names the resident who caused it. The author is the log tag 14
  event, so a rewind shows who did what.
```

## Releasing

Before tagging, run

```bash
python3 .github/scripts/changelog-assemble.py <version> [--date YYYY-MM-DD]
```

and commit the result. It merges the fragments into the `## [Unreleased]` section of
`CHANGELOG.md`, in the order of the table above (entries already written there are
kept, and a fragment is added after them under the same heading), retitles it as the
release, leaves an empty `## [Unreleased]`, and deletes the fragments. Headings the
table does not list stay at the end. The release workflow reads its notes from that
section with `.github/scripts/changelog-section.py`, and it refuses to release while
fragments are still here.

## Checks

`python3 .github/scripts/changelog-assemble.py --check` validates names, sections and
non-empty bodies; CI runs it. The assembler's own tests run with
`python3 .github/scripts/test_changelog_assemble.py`.

The Felix bump bot (`.github/felix-bump.sh`) writes `changelog.d/felix-version.changed.md`,
overwriting it on each bump, so several bumps before a release leave one "Built on Felix" line.
