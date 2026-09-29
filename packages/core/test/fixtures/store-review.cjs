const fs = require('fs');
const path = require('path');
const C = require('../../dist');
const [mode, session, file] = process.argv.slice(2);

if (mode === 'hook') {
  C.handleHookPayload({ session_id: session, cwd: path.dirname(file), tool_name: 'Edit',
    tool_use_id: 'blocked', tool_input: { file_path: file }, hook_event_name: 'PreToolUse' });
  console.log(JSON.stringify({ staged: fs.readdirSync(path.join(C.storeDir(session), 'staging')).length,
    skips: C.readSkips(session).length }));
} else {
  try {
    const row = mode === 'status' ? C.setStatus(session, 1, 'pending') : C.appendLog(session, {
      ts: Date.now(), tool: 'Write', file, beforeBlob: null, beforeState: 'absent',
      afterBlob: C.writeBlob(session, Buffer.from('created\n')), status: 'pending',
    });
    console.log(JSON.stringify({ ok: true, id: row.id }));
  } catch (e) {
    C.appendSkip(session, file, `Contention prevented ${mode}: ${e.message}`);
    console.log(JSON.stringify({ ok: false, error: e.message }));
  }
}
