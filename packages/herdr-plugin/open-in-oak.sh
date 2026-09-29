#!/bin/sh
# herdr inherits the server's PATH, which may contain only system directories.
# Do not source shell startup files: this action also runs over non-login SSH.
set -eu

fail() {
    printf 'OAK: %s\n' "$1" >&2
    exit 1
}

[ -n "${HOME:-}" ] || fail 'HOME is not set; cannot locate OAK'
PATH=${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}
for dir in \
    "${HOME}/.local/bin" /opt/homebrew/bin /opt/homebrew/sbin /usr/local/bin \
    "${HOME}/.local/node/bin" "${VOLTA_HOME:-${HOME}/.volta}/bin" \
    "${NVM_BIN:-}" "${NVM_DIR:-${HOME}/.nvm}/current/bin" \
    "${FNM_MULTISHELL_PATH:+${FNM_MULTISHELL_PATH}/bin}" \
    "${FNM_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/fnm}/aliases/default/bin" \
    "${HOME}/Library/Application Support/fnm/aliases/default/bin" \
    "${HOME}/.fnm/aliases/default/bin"; do
    [ -z "$dir" ] || PATH="$PATH:$dir"
done
# Version-manager installs need their versioned bin directories when no shell
# initialization has selected a version. Preserve an already selected PATH first.
for dir in \
    "${NVM_DIR:-${HOME}/.nvm}"/versions/node/*/bin \
    "${FNM_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/fnm}"/node-versions/*/installation/bin \
    "${HOME}/Library/Application Support/fnm"/node-versions/*/installation/bin \
    "${HOME}/.fnm"/node-versions/*/installation/bin; do
    [ ! -d "$dir" ] || PATH="$PATH:$dir"
done
export PATH

if [ -n "${OAK_BIN:-}" ]; then
    oak=$(command -v "$OAK_BIN") || fail 'OAK_BIN does not name an executable'
elif command -v oak >/dev/null 2>&1; then
    oak=$(command -v oak)
elif command -v claude-observatory >/dev/null 2>&1; then
    oak=$(command -v claude-observatory)
else
    fail 'neither oak nor claude-observatory was found on the augmented PATH'
fi

# Python is already required by herdr's POSIX agent hooks. Parse JSON properly,
# without requiring node (or treating selected text as a session identifier).
command -v python3 >/dev/null 2>&1 || fail 'python3 is required to read the herdr plugin context'
session=$(python3 - <<'PY'
import json
import os
import re
import shutil
import subprocess
import sys


def fail(message):
    print('OAK: ' + ' '.join(message.split()), file=sys.stderr)
    sys.exit(1)


def safe_session(value):
    return (isinstance(value, str) and value not in ('.', '..')
            and re.fullmatch(r'[A-Za-z0-9._-]{1,128}', value) is not None)


def session_from(context):
    if not isinstance(context, dict):
        return None
    for pane in (context, context.get('focused_pane'), context.get('pane')):
        if not isinstance(pane, dict):
            continue
        ref = pane.get('agent_session')
        if isinstance(ref, dict) and ref.get('kind', 'id') == 'id' and safe_session(ref.get('value')):
            return ref['value']
        for key in ('agent_session_id', 'session_id'):
            if safe_session(pane.get(key)):
                return pane[key]
    return None


try:
    context = json.loads(os.environ.get('HERDR_PLUGIN_CONTEXT_JSON') or '{}')
except ValueError:
    context = {}
if not isinstance(context, dict):
    context = {}

session = session_from(context)
if not session:
    pane = os.environ.get('HERDR_PANE_ID') or context.get('focused_pane_id') or context.get('pane_id')
    if not isinstance(pane, str) or not pane:
        fail('no focused pane or agent session in the plugin context')
    herdr = os.environ.get('HERDR_BIN_PATH') or shutil.which('herdr')
    if not herdr:
        fail('herdr was not found on the augmented PATH; cannot resolve the focused pane session')
    try:
        # pane get already emits JSON; it does not accept a --json flag.
        # Inherit HERDR_SOCKET_PATH so this targets the invoking server.
        result = subprocess.run([herdr, 'pane', 'get', pane], capture_output=True,
                                text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        fail('could not run herdr pane get for the focused pane')
    if result.returncode:
        fail('herdr pane get failed for the focused pane; check HERDR_SOCKET_PATH')
    try:
        response = json.loads(result.stdout)
    except ValueError:
        fail('herdr pane get returned invalid JSON')
    if isinstance(response, dict):
        session = session_from(response.get('result', response))
    if not session:
        fail('the focused pane has no valid agent session id')
print(session)
PY
) || exit 1

# The conversation view is named "observatory" in the current OAK focus API.
exec "$oak" focus --session "$session" --tab observatory
