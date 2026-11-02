# Contributing

[docs/design.md](docs/design.md) describes what is being built.

## Code

- Write the simplest thing that meets the design. Don't add abstractions a milestone doesn't need yet.
- Write the rules once. City generation, routing, schedules, the record encoding and route interpolation live in `core/`. The sim links it and the browser uses it as WebAssembly. Never copy that logic into TypeScript.
- The sim is the only authority. The browser draws and interpolates, and never decides what happened.
- The gateway is a relay. Anything that needs to understand a record belongs in `core/`.
- Plain TypeScript and Three.js in `web/`, no UI framework.
- Format with `cargo fmt` and prettier. Pin dependency versions.

## Art

- Every colour comes from the palette module.
- Models are restyled by material name at load time.
- Assets must be CC0 or similarly free and listed with their source and licence in the credits file.
- A change to lighting, materials or post processing comes with before and after screenshots of the same moment and a frame time on an iGPU.

## Comments and docs

- Only comment where the code is unclear, such as a constraint the code can't show.
- Write docs in plain sentences, and update them in the same pull request as the behaviour they describe.

## Changelog

Do not edit `CHANGELOG.md` in a pull request. Add a fragment, `changelog.d/<name>.<section>.md`, so parallel pull requests
stop conflicting on the same lines:

```bash
echo '- Every event names the resident who caused it.' > changelog.d/142-attribution.sim.md
```

`<section>` is `sim`, `page`, `tools`, `added`, `changed` or `fixed`. The file is bullets, written as they should read,
with no `#` headings. [changelog.d/README.md](changelog.d/README.md) has the details and what a release does with them.
CI checks the names with `python3 .github/scripts/changelog-assemble.py --check`.

The README's status table and feature list are still edited by hand.

## Pull requests

- CI must pass before merge. Merges are squash only.
- Add a changelog fragment for any change a user or a contributor would notice.
- No AI attribution in commits or pull request descriptions.
- List design calls under "Review notes", and Felix gaps you hit under "Felix gaps found", with the issue each one is filed as.
