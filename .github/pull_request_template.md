<!--
Thanks for contributing! The golden rule: every feature ships in BOTH editors, with the shared
logic in core → exposed over the CLI --json surface → rendered by each front-end.
See CONTRIBUTING.md and docs/ARCHITECTURE.md.

TARGET BRANCH: feature/fix PRs go into `dev` (the pre-release branch) — GitHub preselects `main`,
so switch the base. Merging into dev publishes a rolling pre-release within minutes.
-->

## What & why

<!-- What does this change do, and why? Link the issue it closes (e.g. Closes #123). -->

## Tested on

<!-- Delete any you did NOT verify — but by convention a feature lands on all three. -->

CLI / VS Code / JetBrains

## Cross-platform parity checklist

- [ ] Shipped in **VS Code** (`packages/vscode`)
- [ ] Shipped in **JetBrains** (`packages/jetbrains`)
- [ ] Shared logic lives in **core** (`packages/core`) and is exposed via **CLI `--json`** (`packages/cli`)
- [ ] `--json` field names are **identical** across CLI / VS Code / JetBrains (stable contract; add, don't rename)
- [ ] 4 test suites updated as needed: core unit (`packages/core/test/core.test.js`), e2e (`test/e2e.sh`), VS Code smoke (`packages/vscode/test/smoke.test.js`), Kotlin port-fidelity (`packages/jetbrains/.../StoreReaderTest.kt` / `SessionsRowsTest.kt`)
- [ ] `node scripts/version.mjs` run (versions in lockstep)
- [ ] Screenshots / docs updated (`scripts/render-media.mjs`, README, `docs/`)
- [ ] One line added under `## [Unreleased]` in `CHANGELOG.md` (the release stamp renames that section to the release version)

<!-- Platform-specific PRs are the exception — if you deliberately skip a platform, say why here. -->
