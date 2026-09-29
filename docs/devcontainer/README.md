# Devcontainer template

A copy-paste starting point for running OAK (and
[claude-statusline](https://github.com/cell-observatory/claude-statusline)) inside a
[devcontainer](https://containers.dev). It solves the three things that break when Claude Code runs
in a container instead of on your laptop:

| Problem | Fix in this template |
| --- | --- |
| **Stats plots bucket by the wrong day/hour** — the container runs UTC. | `TZ` in `containerEnv`. |
| **Edits / Stats reset to empty on every rebuild** — the store lives on the throwaway layer. | `CLAUDE_CONFIG_DIR` on a named **volume** (`mounts`). |
| **Usage bars stay blank** — the status line isn't installed in the container. | `setup.sh` installs it into the same config dir. |

## Use it

1. Copy `devcontainer.json` **and** `setup.sh` into your project's `.devcontainer/` directory.
2. Edit the marked lines: set `TZ` to your timezone, keep `CLAUDE_CONFIG_DIR` and the volume `target`
   in sync, and swap the base `image`/`features` for whatever your project already uses.
3. Rebuild the container. `setup.sh` (via `postCreateCommand`) installs `jq`, the `oak`
   CLI and `python3` if missing, runs `oak doctor --fix` to provision herdr, then installs
   the status line and capture hooks under the persistent config dir.
4. Install the VS Code extension from a release's `.vsix` through **Install from VSIX… → Install in
   Dev Container**.
5. Smoke-test the setup without Claude: `oak demo` works inside the container (the store
   honors `CLAUDE_CONFIG_DIR`) — watch the panels fill in live, then `oak demo --clean`
   removes every trace.

See the repo [README](../../README.md#remote-development-ssh--devcontainers) for the full remote /
SSH story, including setups **without** a devcontainer.


The template also sets `CODEX_HOME=/opt/codex-config` and persists it in the `oak-codex-config` volume. Observatory and Codex must share that backend environment; changing only the desktop client environment does not relocate container rollouts. The existing `CLAUDE_CONFIG_DIR` volume continues to hold the shared Observatory store.
