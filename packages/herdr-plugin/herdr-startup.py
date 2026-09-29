"""Restart the system monitor in herdr's `btop` tab when herdr's server starts.

herdr runs this once per server start ([[startup]] in herdr-plugin.toml), after it has restored the
saved session. herdr 0.9.1 restores the monitor's pane as a plain shell, so after a reboot the monitor
in the `btop` tab is gone until something starts it again. This starts it before any OAK runs, by the rules
OAK's terminal app applies on every refresh (packages/core/src/herdr-tabs.ts):

- the monitor runs in the pane OAK labelled `btop` (herdr keeps pane labels across restarts), in the
  first tab labelled `btop` of the workspace labelled `home` (else the first workspace) whose
  monitor pane holds no agent; any other pane, such as one a person split off beside it, is theirs;
- the monitor is typed only into that pane, while its shell holds the terminal's foreground with no
  command running (herdr's pane.process_info), never into anything else.

It restarts; it never creates, renames, labels or closes anything. A missing `btop` tab, one an agent
has taken over, or one from before OAK labelled the monitor's pane is left to OAK's terminal app.

Usage: python3 herdr-startup.py [seconds to wait for the shell's prompt, default 30]
"""
import json
import os
import socket
import sys
import time

BTOP = 'btop'
HOME_WORKSPACE = 'home'
# Identical to MONITOR_LAUNCH in packages/core/src/herdr-tabs.ts; a test compares the two.
MONITOR_LAUNCH = 'm=$({ command -v btop; command -v bpytop; command -v htop; } 2>/dev/null | grep -m1 "^/"); [ -n "$m" ] && exec "$m"\n'
POSIX_SHELLS = {'sh', 'ash', 'bash', 'dash', 'ksh', 'mksh', 'zsh'}


def request(method, params):
    """One NDJSON request per connection, as herdr's socket API expects."""
    conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    conn.settimeout(15)
    try:
        conn.connect(os.environ['HERDR_SOCKET_PATH'])
        conn.sendall((json.dumps({'id': 'oak-startup', 'method': method, 'params': params}) + '\n').encode())
        data = b''
        while b'\n' not in data:
            chunk = conn.recv(65536)
            if not chunk:
                break
            data += chunk
    finally:
        conn.close()
    reply = json.loads(data.split(b'\n', 1)[0].decode())
    if 'error' in reply:
        raise RuntimeError('%s failed: %s' % (method, reply['error'].get('message', reply['error'])))
    return reply['result']


def foreground(info):
    """'idle' (a POSIX shell at its prompt), 'replaced' (the shell's process now runs something else)
    or 'busy' — the same answer as paneForeground in herdr-tabs.ts."""
    info = info or {}
    shell = info.get('shell_pid')
    procs = info.get('foreground_processes') or []
    if shell is None or info.get('foreground_process_group_id') != shell or not procs \
            or any(p.get('pid') != shell for p in procs):
        return 'busy'
    name = os.path.basename(str(procs[0].get('name') or ''))
    if name.startswith('-'):
        name = name[1:]
    return 'idle' if name in POSIX_SHELLS else 'replaced'


def monitor_pane(snapshot):
    """The monitor's pane, or None."""
    workspaces = snapshot.get('workspaces') or []
    home = next((w for w in workspaces if (w.get('label') or '').strip().lower() == HOME_WORKSPACE),
                workspaces[0] if workspaces else None)
    if home is None:
        return None
    panes = snapshot.get('panes') or []
    held = set(p['pane_id'] for p in panes if p.get('agent'))
    held.update(a['pane_id'] for a in snapshot.get('agents') or [] if a.get('pane_id'))
    for tab in snapshot.get('tabs') or []:
        if tab.get('workspace_id') != home['workspace_id'] or tab.get('label') != BTOP:
            continue
        monitor = next((p['pane_id'] for p in panes
                        if p.get('tab_id') == tab['tab_id'] and p.get('label') == BTOP), None)
        if monitor is not None and monitor not in held:
            return monitor
    return None


def main():
    deadline = time.time() + (float(sys.argv[1]) if len(sys.argv) > 1 else 30.0)
    while True:
        pane = monitor_pane(request('session.snapshot', {})['snapshot'])
        if pane is None:
            return 0
        state = foreground(request('pane.process_info', {'pane_id': pane})['process_info'])
        if state == 'idle':
            request('pane.send_text', {'pane_id': pane, 'text': MONITOR_LAUNCH})
            return 0
        if state == 'replaced' or time.time() >= deadline:
            return 0
        time.sleep(0.5)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:  # one line in `herdr plugin log list`, not a traceback
        sys.stderr.write('OAK: %s\n' % ' '.join(str(error).split()))
        sys.exit(1)
