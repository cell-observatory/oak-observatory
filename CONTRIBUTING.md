# Contributing to OAK

Thanks for helping build the observatory. This guide is the practical "add a feature across all
platforms" playbook. For the deeper "how it really works" reference — the dependency graph, the
store format, the `--json` contract table — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
Prose in the site, the READMEs and the walkthroughs follows [docs/STYLE.md](docs/STYLE.md).

## The golden rule

> **Every feature ships in BOTH editors, with the shared logic in `core` → exposed over the CLI
> `--json` surface → rendered by each front-end.**

No feature lands in one editor only. The engine and every view-model live in `packages/core`; the
CLI is the machine-readable view API; the two editors are thin renderers. If you catch yourself
writing tree-building, delta math, or transcript parsing inside `packages/vscode` or
`packages/jetbrains`, stop — that logic belongs in `core`.

```
                 packages/core  (pure TS engine + view-models; runtime deps: diff, smol-toml; terminal backend: herdr)
                 buildEditTree / undoEdit / computeStats / observe / …
                          │
                          ▼
                 packages/cli  (`oak` — the --json view API + terminal UI)
                 switch(argv[0]) → cmdTree/cmdObserve/cmdStats/… → emitJson(...)
                    │                                              │
          in-process import                              subprocess: `… --json`
                    │                                              │
                    ▼                                              ▼
        packages/vscode                                packages/jetbrains (Kotlin)
        import * as core                               ObservatoryCli.run([...,"--json"])
        core.buildEditTree(...) directly               → Gson parser → hand-mirrored model
        + spawns CLI sessions and heavy views         + reads store off disk via StoreReader
```

Two things to internalize about that diagram:

- **VS Code consumes `core` in-process** (`import * as core from '@oak-observatory/core'`) for
  store operations, and spawns the CLI for session listings and heavy views. It renders the
  same view-models the CLI emits, computed by the same functions.
- **JetBrains never imports `core`.** It (a) reads the store off disk through Kotlin ports of a few
  `core` modules (`StoreReader`, `ClaudePaths`), and (b) shells out to
  `oak … --json` for session listings, automatic session selection, every store *mutation* and every diff-dependent read. The undo
  engine's correctness lives in one place — the TS core — on purpose.

## Repo layout

| Package | What it is |
| --- | --- |
| `packages/core` | Pure-TS engine + view-models (store, surgical undo, edit-tree, observations, stats). Runtime dependencies are `diff` and `smol-toml`. Re-exports from `src/index.ts`. No model calls. |
| `packages/cli` | The `oak` bin: installer + terminal review UI + the machine-readable `--json` surface both editors build on. `main()` is a `switch` on `argv[0]`. |
| `packages/vscode` | The VS Code extension. Imports `core` in-process; declares all UI in `package.json`'s `contributes`; bundled with esbuild. |
| `packages/jetbrains` | The JetBrains/PyCharm plugin (Kotlin). A front-end over the CLI + store — hand-mirrored models, port-fidelity tests, panels under `ui/`. |
| `packages/herdr-plugin` | OAK's herdr plugin: a `herdr-plugin.toml` manifest, the *Open in OAK* action's scripts and a startup hook that restarts the `btop` monitor, linked into the user's herdr by `ensureHerdr()`. Not an npm workspace. |

## Add a feature end-to-end

Numbered steps, mapped to the concrete files you touch. The `tree --json` path (see the worked
example below) is the reference implementation of every step.

### 0. `core` — the logic and the shape

- Add/extend a function in the right module under `packages/core/src/` (e.g. `tree.ts`,
  `observe.ts`, `stats.ts`, `undo.ts`, `store.ts`).
- If you add data, extend the relevant `interface` in the same module (e.g. a new field on
  `TreeEdit`, `EditRecord`, or `StatsResult`).
- **Re-export it** from `packages/core/src/index.ts` (`export * from './<mod>'`) so the CLI and the
  VS Code extension can reach it.
- Keep it pure: no `vscode`/IDE imports, no network, no model calls.

### 1. `cli` — expose it over `--json`

- Add or extend a handler in `packages/cli/src/index.ts`: a `cmdX(args)` function that calls your
  `core` function and emits the result with `emitJson(...)`.
- Wire it into the `switch (cmd)` in `main()`, and add a line to `usage()`.
- **`--json` field names are a stable contract** — both editors parse them by name. Renaming a
  field is a breaking change; add, don't rename.
- Reuse a session with `getSessionId(args)` (honours `--session`, env vars, then `resolveSessionId`).

### 2. VS Code — consume `core`, declare UI

- In `packages/vscode/src/extension.ts`, call `core.*` in-process (e.g. `core.buildEditTree`,
  `core.undoEdit`, `core.setStatus`, `core.readLog`, `core.fileMemory`). For a heavy scan, spawn the
  CLI subprocess instead (that's how Stats works).
- If it's tree/observe-shaped data, it flows through the existing providers (`ReviewViewProvider`,
  the Observations/Timeline providers) — extend those rather than adding a parallel path.
- Declare every UI affordance in `packages/vscode/package.json` under `contributes`:
  `commands`, `menus`, `keybindings`, `views`/`viewsContainers`, `configuration`.

### 3. JetBrains — wrapper, model, service, panel, registration

- Add a typed wrapper in `core/ObservatoryCli.kt` (e.g. `treeJson(...)`, `observeJson(...)`) that
  shells out to your new `--json` command.
- If it returns a **new shape**, add a Kotlin `data class` + a Gson parser under `model/`
  (`Models.kt` / `Tree.kt` / `Observe.kt`), **mirroring the TS type field-for-field**.
- If you touched a **store-format** read (log/blob/session/path semantics), update the corresponding
  port in `core/StoreReader.kt` / `ClaudePaths.kt` and keep the port-fidelity tests green
  (see step 4). Session selection comes from the CLI; do not add a separate disk resolver.
- Fetch/cache in a service (`services/ObservatoryService.kt` or a dedicated cache), render in the
  matching panel under `ui/`, and register any new actions / tool windows / status-bar widgets in
  `src/main/resources/META-INF/plugin.xml`.

### 4. Tests — four suites

| Suite | File | When to touch |
| --- | --- | --- |
| core unit | `packages/core/test/core.test.js` | any new/changed `core` function |
| e2e | `test/e2e.sh` | anything that touches the CLI (add a `--json` assertion with `jq`) |
| VS Code smoke | `packages/vscode/test/smoke.test.js` | new command/provider/contribution |
| Kotlin port-fidelity | `packages/jetbrains/src/test/kotlin/.../StoreReaderTest.kt`, `SessionsRowsTest.kt`, `SessionSelectionTest.kt` | any change to a store model or session contract |

### 5. Version — keep everything in lockstep

Run `node scripts/version.mjs` (checks for drift) before you push. To bump, run
`node scripts/version.mjs <x.y.z>` — it rewrites all four `package.json` versions, the JetBrains
`build.gradle.kts`, and the `@oak-observatory/core` dep-pins together. `version:check` is gated
inside `npm test`, so drift fails CI.

## Worked example: the `tree --json` path

The folder → file → class → edit tree is the canonical shared view. It exists exactly once and is
rendered by both editors:

1. **core** — `buildEditTree(session, { root, filter })` in `packages/core/src/tree.ts` returns an
   `EditTree` (`folders` / `files` → `TreeFolder` → `TreeFile` → `TreeClass` → `TreeEdit` with
   `added`/`removed` deltas). Re-exported from `index.ts`.
2. **cli** — `cmdTree` (`case 'tree'` in `main()`) calls `core.buildEditTree(...)` and
   `emitJson(...)` it. Listed in `usage()` as `tree [--root <d>] [--filter <q>]`.
3. **VS Code** — the Review webview builds its rows from `core.reviewEdits` + `core.cancelledGroups`
   **directly** (in-process) and posts them; the same in-process rule holds for every other view.
   `buildEditTree` is the JetBrains tree's payload rather than VS Code's since 0.9.4.
4. **JetBrains** — `ObservatoryService.refreshEditTree()` calls `ObservatoryCli.treeJson(...)`,
   `model/Tree.kt`'s `TreeParser.parse(...)` turns the JSON into the mirrored `EditTree` data
   classes, and `ui/EditsTreePanel.kt` renders it inside the Review tab. That payload also carries
   `hiddenIds`, which every derived count in the plugin filters by — add a new count and it must
   read the same set, or it will disagree with the tree beside it.

Copy this shape for any new structured view.

## Build & test cheat-sheet

| Task | Command |
| --- | --- |
| Install dependencies | `npm ci` — under npm 12 it blocks the install scripts of esbuild, keytar and vsce-sign, which the build does not need; node-pty's is allowed through the `allowScripts` field of the root `package.json`. |
| Build core + tui + CLI | `npm run build` — its last step links `node_modules/.bin/oak`, the tree's CLI that the VS Code smoke test and `./gradlew test` drive; `npm ci` skips that link while the CLI is unbuilt. |
| After editing `packages/tui` | `npm run build` **including the cli step** — the CLI bundle **inlines** the tui package (esbuild), so a tui-only rebuild leaves `packages/cli/dist` stale and the npm-linked `oak` runs your OLD code with no error anywhere. This has bitten twice; when a TUI change "does nothing", check the bundle first. |
| After editing a `fold*Facts` derivation | Nothing to remember: the persisted facts' cache key hashes the fold functions' own source (`FOLD_STAMP` in `packages/core/src/derived-transcript.ts`), so an edited fold addresses a different cache file and the next read re-folds. Bump `TRANSCRIPT_FACTS_VERSION` in the same file when the stored SHAPE changes — the version rides the file name (`transcript-facts-v<N>-<key>.json`), and `oak clean [--session <id>]` reclaims the generation a bump supersedes. To force a rebuild by hand, delete `changemap-cache/*/transcript-facts-*.json` under the store (`~/.claude/claude-observatory`). |
| Build the VS Code bundle | `npm run build:vscode` |
| Build the JetBrains plugin | `./gradlew buildPlugin` (in `packages/jetbrains`) |
| Unit + smoke tests | `npm test` (version, privacy and webview checks → build → build:vscode → `node --test` over the core, CLI, TUI and VS Code suites) |
| End-to-end CLI + hook | `npm run e2e` (`bash test/e2e.sh`, isolated temp `$HOME`) |
| JetBrains port tests | `./gradlew test` (in `packages/jetbrains`) |
| Everything | `npm run test:all` |
| Check/bump version | `node scripts/version.mjs [<x.y.z>]` |
| Rebuild site pages | `node scripts/build-docs.mjs` — sources are in `docs/_content/`; never edit the generated `docs/*.html` pages by hand. |
| Rebuild the terminal demo | `node scripts/build-tui-demo.mjs` — writes `docs/media/tui-frames.js`. |
| Refresh TUI screenshots | `CHROME_BIN=/path node scripts/build-tui-shots.mjs [--herdr]` — `CHROME_BIN` names the Chrome/Chromium executable; `--herdr` includes the herdr tab. |
| Refresh editor screenshots/media | `CHROME_BIN=/path node scripts/render-media.mjs` — `CHROME_BIN` names the Chrome/Chromium executable. |
| Run CI's matrix before a push | `bash scripts/ci-local.sh` — the Linux lanes in Docker across CI's Node versions, then this platform's own; `--quick` runs Linux on the oldest Node only, `--native` skips the containers. |
| Time the hot paths | `node scripts/perf-bench.mjs [edits] [files]` — a synthetic many-edit session in a temporary store (default 3000 edits over 150 files). |
| Codex I/O-budget check *(optional)* | `npm run test:codex-perf` — deterministic, no model or network |
| Codex hook-trust probe *(optional)* | `npm run test:codex-probe` — needs a real `codex` binary |
| VS Code host smoke *(optional)* | launch via VS Code's `--extensionTestsPath test/vscode-host-smoke.cjs` — needs a real VS Code |
| Live herdr checks *(optional)* | `OAK_LIVE_HERDR=1 npm test` — points the suite at the herdr server in your environment and runs the checks that need one (skipped otherwise); without it every test talks to a missing socket |
| herdr backend probe *(optional)* | `node test/herdr-probe.js` — needs `herdr` on `PATH` (or `HERDR_BIN`) and runs a sandboxed server of its own |
| Claude hook probe *(optional)* | `node test/claude-hooks-probe.js` — needs a logged-in `claude` on `PATH` and node-pty, and spends one Haiku turn |

The optional checks are **not** part of `npm test` (they need external tooling) — run them by hand.
Both `test:codex-*` need a build first (`npm run build`). `test:codex-perf` is a deterministic local I/O
budget — no model, no network. `test:codex-probe` drives a real `codex app-server` and exits cleanly when
no `codex` binary is on `PATH`. `test/vscode-host-smoke.cjs` is an extension-host test: VS Code loads it via
`--extensionTestsPath` (with `OAK_HOST_SMOKE=1` and an isolated user-data dir), not `node`.
`test/herdr-probe.js` executes the herdr seams OAK builds on and skips loudly without herdr — run it
after moving the herdr pin. `test/claude-hooks-probe.js` checks that Claude Code really fires every
hook the installer writes, which unit tests cannot see — run it after changing the hook events or
matchers.

(The `./gradlew` wrapper still needs a JVM to launch — on a bare macOS, point `JAVA_HOME` at a JDK, e.g.
`JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew …`; the build then provisions its own JDK 21 toolchain.
Always use the wrapper, never an ambient `gradle` — `scripts/release.sh` forbids the latter.)

**TypeScript is held at 5.x on purpose.** Your editor needs no setup beyond one `npm run build`,
which produces the `packages/core/dist` declarations the other packages import. IntelliJ's TypeScript
service auto-detects `node_modules/typescript`, and VS Code works with its own bundled copy either way.

The reason for the pin is that TypeScript 7 — the native rewrite — ships only the `tsc` driver on npm.
`node_modules/typescript/lib` holds no `tsserver.js` and no `lib.*.d.ts`, and `require('typescript')`
returns nothing but a version, because the compiler lives in a per-platform binary. Builds and CI pass
on it (they only ever invoke `tsc`), so the breakage is invisible to automation and shows up only as an
editor that has quietly stopped reporting type errors. `.github/dependabot.yml` therefore ignores
TypeScript majors; when the language service ships, take the major deliberately —
`tsconfig.base.json` already uses `node16` resolution, which is all 7.x needs from this repo.

CI (`.github/workflows/{linux,macos,windows}.yml` — one workflow per OS so each carries its own
README badge) runs `npm test` across `node {20,22,24}` plus e2e on Linux/macOS (e2e is skipped on
Windows), while `vscode.yml` builds the release artifacts and `jetbrains.yml` runs the Gradle suite +
`buildPlugin`.

## Bumping the herdr pin

herdr is a hard runtime dependency, pinned in `herdr.lock` at the repo root: a version, herdr's
socket `protocol` generation, and the release asset URL + sha256 for each of the five platforms
herdr publishes. The core build compiles the lockfile into `packages/core/src/herdr-lock.ts`
(generated and gitignored), so the pin travels inside every bundle, a global npm install included.
Only `packages/core/src/herdr-install.ts` imports it, and its `ensureHerdr()`, `probeHerdr()`,
`downloadHerdrAsset()` and `readHerdrLock()` default to it. `oak doctor`, `oak update`,
`oak machine add` and the version check in `packages/core/src/herdr.ts` read the pin through those
four. The CLI build stages `packages/herdr-plugin/` inside `dist/`.

To move the pin:

1. Update `herdr.lock`: version, protocol, asset URLs and their verified SHA-256 digests from
   the upstream release manifest. Install that binary in an isolated test environment.
2. Regenerate the embedded pin and socket types from the repository root:

   ```sh
   npm run gen:herdr-lock -w packages/core
   HERDR_BIN=/path/to/herdr npm run gen:herdr -w packages/core
   ```

3. Review the generated protocol changes in `herdr-lock.ts` and `herdr-api.d.ts`; keep adaptation
   inside `core/src/herdr.ts`. Update the plugin minimum version when its API requirements change.
4. Typecheck and build the affected packages, then run the tests. In a sandbox that disallows Node
   test workers, use `node --test --test-isolation=none <files>`; live tests skip only when their
   actual binary or socket prerequisite is unavailable.
5. Run `oak doctor --fix` on an installation with the previous pin and on a clean installation.
   Verify integrations, the plugin, a real PTY spawn and the focus endpoint. Release checks are
   `npm run version:check`, `npm run check:privacy` and `npm run check:webview`.

`ensureHerdr()` never downgrades: a machine running a herdr newer than the pin keeps it, so bumping
the pin is always safe to ship ahead of a user's own upgrade.

## Cross-platform parity checklist

Every feature PR must satisfy:

- [ ] Shipped in **VS Code** (`packages/vscode`)
- [ ] Shipped in **JetBrains** (`packages/jetbrains`)
- [ ] Shared logic lives in **core** (`packages/core`) and is exposed via **CLI `--json`** (`packages/cli`)
- [ ] `--json` field names are **identical** across CLI / VS Code / JetBrains (stable contract; add, don't rename)
- [ ] 4 test suites updated as needed: core unit, e2e, VS Code smoke, Kotlin port-fidelity
- [ ] `node scripts/version.mjs` run (versions in lockstep)
- [ ] README and `docs/_content/` updated; site pages rebuilt with `node scripts/build-docs.mjs`; affected media regenerated with `scripts/build-tui-demo.mjs`, `scripts/build-tui-shots.mjs` or `scripts/render-media.mjs` (see the cheat-sheet).

## Proposing a feature & the PR flow

- **Propose** with the [Feature request](.github/ISSUE_TEMPLATE/feature_request.yml) issue form —
  it asks which surface it affects, which platforms it must land in, and the expected `--json`
  surface.
- **Open a PR against `dev`** using the [pull request template](.github/pull_request_template.md) —
  it carries the parity checklist above and a "tested on: CLI / VS Code / JetBrains" line. Fill both
  in. GitHub preselects `main` as the base (it stays the default branch for the installer URLs) —
  switch it to `dev`; a maintainer will retarget any PR that misses this.
- **Add your changelog line** under `## [Unreleased]` in `CHANGELOG.md` as part of the PR — one
  entry in the changelog's voice, saying what changed and why it matters. The release stamp renames
  that section to the release version, and the Release workflow publishes it as the release notes, so
  your words ship with the release that carries your work.
- **After the merge**: every push to `dev` republishes the rolling pre-release within minutes — run
  `oak update --channel dev` (or use the Overview's version chip) and you are using
  your own feature the same hour. It reaches the stable channel with the next release.

Every PR runs the full three-OS test matrix, both editor builds, and CodeQL, whatever its origin;
fork PRs run with a read-only token, and nothing publishes until a maintainer merges. By convention,
features ship on **all** platforms; a platform-specific exception needs a reason in the issue/PR.

### Branches & releases: how a change reaches users

```text
feature/fix branch ──PR──▶ dev (pre-release channel) ──release/X.Y.Z──PR──▶ main (stable channel, tagged releases)
```

- **Feature and fix PRs target the persistent `dev` branch**, not `main`. Every PR runs the full
  three-OS test matrix.
- **Every push to `dev`** makes the [Dev pre-release workflow](.github/workflows/dev-release.yml)
  re-stamp the version as `<next>-dev.<run#>`, rebuild every artifact, and refresh the ONE rolling
  GitHub release (tag `dev-latest`, marked *prerelease* so `releases/latest` — the stable channel —
  never serves it). Anyone on the **pre-release channel** (`oak update --channel dev`,
  or the version chip in either editor's Overview) gets it on their next update. The workflow
  refuses to publish until the repository carries its `oak-observatory` name, and when the rolling
  version does not outrank both the published pre-release and the newest stable release; after the
  upload it fails if a pre-rename `claude-observatory-*` asset is still attached to `dev-latest`.
- **When dev has soaked**, it is promoted through a release branch (see *Cutting a release*); the
  `vX.Y.Z` tag on `main` makes the [Release workflow](.github/workflows/release.yml) publish the
  official GitHub Release — the stable channel — with the version's CHANGELOG section as its notes.
- `main` stays the default branch (installer URLs and docs point at `raw/main`), and history that
  shipped keeps the names it shipped with — the changelog's past entries are immutable.

**Cutting a release.** `main` and `dev` never merge back into each other, so a release is a branch
of its own:

1. Branch `release/X.Y.Z` off `dev` and run `node scripts/version.mjs X.Y.Z`. Besides every version
   field, the stamp renames the changelog's `## [Unreleased]` to `## [X.Y.Z] — <date>` under a fresh,
   empty `[Unreleased]`. That section is what the Release workflow publishes as the release notes.
   The stamp does not date the release on the site: in `docs/_content/releases.html`, set the
   entry's `<time datetime="YYYY-MM-DD">YYYY-MM-DD</time>` to the date of the changelog heading, then
   run `node scripts/build-docs.mjs`. Commit the stamp and the date: the merge in step 2 refuses to
   run over uncommitted changes.
2. Merge `origin/main` into the branch. Every file both branches changed since their merge base
   conflicts: the version-bearing files on the previous stamp, and the READMEs, site pages and
   CHANGELOG. For 0.10.0, whose merge base is older than the 0.9.5 fixes (they reached `main` as
   cherry-picks), source and test files conflict as well: a trial merge gave 22 conflicts, 7 of them
   code, with `packages/core/src/update.ts` as add/add. Resolve them all as ours
   (`git checkout --ours <file>`, then `git add` it), and keep main's own commits that merge cleanly
   (its Dependabot pins). Ours is right only while `main` holds no change that `dev` lacks, so check
   that before resolving. This prints each conflicted file whose `main` version the branch never had:

   ```bash
   for f in $(git diff --name-only --diff-filter=U); do
     git log --format=%H HEAD -- "$f" | while read -r c; do git rev-parse -q --verify "$c:$f"; done |
       grep -qx "$(git rev-parse "origin/main:$f")" || echo "$f"
   done
   ```

   Expect only CHANGELOG.md and the version-bearing files (the `package.json` files, the lockfile,
   the README badge and the site pages), whose `main` versions carry main's stamp. Merge any source or
   test file it prints by hand. `packages/jetbrains/build.gradle.kts` can merge to main's older
   version without a conflict, so run `node scripts/version.mjs X.Y.Z` and `npm run version:check`
   again once every conflict is resolved, and commit the merge with what the stamp changed
   (`git commit -a`).
3. Check the changelog: `git diff origin/main -- CHANGELOG.md` must add only the new section, apart
   from edits `dev` made above it: 0.10.0 renames the product in the header and removes main's
   placeholder comment under `[Unreleased]`. `dev` carries main's released sections verbatim, and the
   changelog's past entries are immutable.
4. Open the PR from `release/X.Y.Z` to `main`. Once CI is green, merge it and push the `vX.Y.Z` tag;
   the Release workflow checks the tag against the committed version before it builds anything.
5. On `dev`, in one change: take the released CHANGELOG from `main`, keeping under `[Unreleased]` any
   entries `dev` gained since the branch was cut, and bump the committed version to the next target
   **as a prerelease of it** — `node scripts/version.mjs 0.11.0-dev.0`, not `0.11.0` (see *Version
   numbering*). The entries to keep are the lines `git diff vX.Y.Z origin/dev -- CHANGELOG.md` adds.
   Besides them it removes the release's heading, and an entry the release branch reworded shows as
   removed and re-added (keep main's wording). The diff compares contents, not history, so it holds
   however the PR was merged: after a squash merge, the tag's history does not contain the commit the
   branch was cut from. Until the bump, the Dev pre-release workflow refuses to publish, because a
   rolling `X.Y.Z-dev.N` does not outrank the stable `X.Y.Z`.

**Version numbering.** `dev`'s committed version is the NEXT stable target, written as a prerelease
of it — `0.10.0-dev.0` — so rolling builds are `<target>-dev.<n>`. The target is a FLOOR: at promote
time you may raise it (bump, then tag higher) but never tag below it — a stable below the published
dev builds strands the pre-release channel above the version line.

The `-dev.0` suffix matters and is not cosmetic. By semver a prerelease sorts BELOW its release, so a
committed plain `0.10.0` outranks every `0.10.0-dev.<n>` CI publishes — which means anyone who built
and installed from a `dev` checkout (`./install.sh`, or `code --install-extension` on a local .vsix)
landed above the channel line and stopped receiving updates entirely, on both channels, while every
surface reported a green "up to date". Committing `0.10.0-dev.0` puts a local build BELOW the
rolling ones, where it belongs. `scripts/version.mjs` accepts the form and CI strips the suffix
before re-stamping (`BASE="${BASE%%-*}"`), so nothing downstream changes.

The updater no longer depends on getting this right — it acts on any DIFFERENCE from the channel's
newest, in either direction, so a stranded install is pulled back onto the channel rather than
ignored. The stamp keeps the ordering honest anyway; both belong.

**Hotfixes.** A critical fix that must reach STABLE users before the next promote does not ship
from `dev` (which carries unreleased work). Instead: land the fix on `dev` as usual, then
cherry-pick it onto `main` (or a branch from the last release tag, if `main` has moved), bump the
patch version (`node scripts/version.mjs 0.9.1`), add a `[0.9.1]` changelog section, and tag — the
Release workflow publishes it. The ordering stays coherent by construction: stable users get the
patch, and pre-release users — whose `<next>-dev.<n>` builds already carry the fix and outrank the
patch — correctly ignore it. Landing on `dev` FIRST is what makes that true; a hotfix that only ever
touches `main` never reaches the pre-release channel at all.

The user-facing story of the two channels lives on
[the Releases page](https://cell-observatory.github.io/oak-observatory/releases.html).
