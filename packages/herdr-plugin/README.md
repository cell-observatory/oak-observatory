# OAK's herdr plugin

One action — **Open in OAK** — so herdr's own action list and keymap can reach the OAK
observatory for the pane you are looking at, and one startup hook that restarts the system monitor
in the `home` workspace's `btop` tab whenever herdr's server starts.

`ensureHerdr()` (`oak doctor --fix`, `oak update`, both installers) links this directory with
`herdr plugin link <absolute path>`, which registers it for the current user with or without a
running herdr server. Nothing here is installed from GitHub, so herdr runs no build commands.
herdr rereads the manifest at every server start, so a changed manifest needs no new link.

```bash
herdr plugin list                                 # oak.observatory should be listed and enabled
herdr plugin action list --plugin oak.observatory
herdr plugin action invoke oak.observatory.open-in-oak
```

On Windows, invoke `oak.observatory.open-in-oak-windows` instead. Both actions have the
title **Open in OAK** and declare their supported platforms.

## What it does

The wrapper resolves the native agent session from `HERDR_PLUGIN_CONTEXT_JSON` when supplied
(`agent_session.value`, `agent_session_id`, or `session_id`, at the top level or inside
`focused_pane`/`pane`). Herdr 0.9.1 normally supplies just `focused_pane_id`: the wrapper then
uses `HERDR_PANE_ID` or that context field to run `herdr pane get <id>` and read
`result.pane.agent_session.value`. It prefers `HERDR_BIN_PATH` over searching for herdr and
inherits `HERDR_SOCKET_PATH`, so the lookup reaches the server that invoked the action.
Only valid OAK session IDs are accepted; path references and unrelated context text are ignored.

It invokes `oak focus --session <id> --tab observatory`, falling back to the CLI name
`claude-observatory` when `oak` is absent. The current CLI calls its conversation view
`observatory`; `conversation` is not an accepted focus tab. `OAK_BIN` can explicitly select
an executable. Start `oak tui` first; the local `oak server` focus endpoint routes the request
and never owns the agent terminal.

On Linux and macOS, `open-in-oak.sh` runs under POSIX `sh` and extends the inherited `PATH` with:

- `$HOME/.local/bin`, `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`,
  and `$HOME/.local/node/bin`;
- Volta's bin directory, nvm's current/versioned bin directories, and fnm's default/versioned
  installation directories (including macOS's `Library/Application Support/fnm`);
- custom locations supplied by `VOLTA_HOME`, `NVM_DIR`, `NVM_BIN`, `FNM_DIR`,
  `FNM_MULTISHELL_PATH`, and `XDG_DATA_HOME`.

This works when a server started over non-login SSH inherits only system directories. It
does not source login scripts. Python 3 parses JSON, as in herdr's POSIX agent hooks. There is
no Node-based plugin launcher; an npm-installed OAK CLI still needs its own Node runtime,
which uses the same augmented `PATH`.

Windows uses `open-in-oak.cmd` to find the system PowerShell by absolute path, then runs
`open-in-oak.ps1`. That script parses JSON natively and extends `PATH` with local OAK, npm,
Node, nvm, fnm, and Volta locations. It supports `.cmd` CLI shims. Windows runtime behavior
must be validated on Windows; the standalone regression tests exercise the POSIX wrapper.

Missing executables, missing session IDs, and failed pane lookups produce a one-line `OAK:`
diagnostic on stderr and a nonzero exit. OAK's own output and exit status pass through.
Inspect failures with `herdr plugin log list`.

## Startup hook

herdr runs each `[[startup]]` command once per server start, after it has restored the saved
session, with `HERDR_SOCKET_PATH` and `HERDR_BIN_PATH` in the environment and this directory as the
working directory. herdr 0.9.1 restores the monitor's pane as a plain shell, so after a reboot the
monitor is gone. `herdr-startup.py` starts it again before any OAK runs, by the rules OAK's
terminal app applies on every refresh (`packages/core/src/herdr-tabs.ts`):

- The monitor runs in the pane OAK labelled `btop` (herdr keeps pane labels across restarts), in the
  first tab labelled `btop` of the workspace labelled `home`, or of the first workspace when none
  is, whose monitor pane holds no agent. Any other pane in that tab, such as one split off beside
  the monitor, belongs to the person.
- The monitor's command line is typed only into that pane while its shell holds the terminal's
  foreground with no command running, as `pane.process_info` reports it; the hook waits up to 30
  seconds for a shell that is still starting. It never types into anything else.

The hook restarts only: it never creates, renames, labels or closes anything. A missing `btop` tab,
one an agent has taken over, or one from before OAK labelled the monitor's pane is left to OAK's
terminal app. The command line runs btop, else bpytop or htop, resolved in that pane's own shell. It
is POSIX shell syntax, so the hook declares Linux and macOS only and leaves any other shell alone.
It needs `python3`, like herdr's POSIX agent hooks, and speaks herdr's socket directly, so it works
with the minimal `PATH` a server started over SSH has. Failures print one `OAK:` line; see them
with `herdr plugin log list`.

## Manifest notes

- `contexts = ["pane"]` puts the action on a focused pane.
- herdr runs `command` as an **argv array with no shell**, and does not substitute anything into it.
  The pane identity arrives in the environment instead (`HERDR_PANE_ID`,
  `HERDR_PLUGIN_CONTEXT_JSON`), which the wrappers read. Herdr sets the working directory to
  `HERDR_PLUGIN_ROOT`, so relative script filenames work without argument templates.
- Action-level `platforms` select the POSIX and Windows commands. Herdr rejects duplicate action
  IDs even on different platforms, hence the separate Windows action ID.
- `min_herdr_version` matches the pin in `herdr.lock`; herdr refuses to link a plugin whose minimum
  is newer than the binary, and `ensureHerdr()` never leaves an older one installed.

## Standalone regression tests

From the repository root, run `node --test packages/core/test/herdr-plugin.test.js`.
The tests launch the actual wrapper through `env -i PATH=/usr/bin:/bin HOME=<temp-home>`
with fake CLIs in that temporary home's installation directories. They verify argv, context
and pane lookup, executable discovery, and stderr/exit failures without opening a herdr socket
or writing to your real home directory. Discovery cases that require a missing global CLI skip
when one is installed in the searched system directories. The startup-hook tests run
`herdr-startup.py` the same way against a scripted herdr socket in a temporary directory, and
check that its launch line and its reading of a pane match OAK's reconciler; those need the core
built first (`npm run build`). Node is only the test runner; if a sandbox blocks its test-runner
IPC, use `node --test --test-isolation=none` with the same file.
