// Scan the actual outer PTY bytes, retaining absolute offsets for their timestamps and write stacks.
// Control strings span read boundaries; a BEL terminates OSC, but is payload inside DCS/APC/PM/SOS.
module.exports = function scan(bytes) {
  const events = [];
  let state = 'ground', begin = 0, body = '', sync = false, string = '', escaped = false;
  const add = (kind, at, extra = {}) => events.push({ kind, offset: at, sync, ...extra });
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (state === 'string') {
      if ((string === 'OSC' && c === 7) || (escaped && c === 92)) {
        add('string', begin, { string, terminator: c === 7 ? 'BEL' : 'ST', text: bytes.subarray(begin, i + 1).toString() });
        state = 'ground'; escaped = false;
      } else escaped = c === 27;
      continue;
    }
    if (state === 'csi') {
      body += String.fromCharCode(c);
      if (c >= 0x40 && c <= 0x7e) {
        if (body === '?2026h') { sync = true; add('sync-on', begin); }
        else if (body === '?2026l') { add('sync-off', begin); sync = false; }
        else if (/^\?1049[hl]$/.test(body)) add('alternate', begin, { sequence: body });
        else if (/^[23]J$/.test(body)) add('erase', begin, { sequence: body });
        else if (body === 'H') add('frame', begin);
        else if (!sync && /[HKf]$/.test(body)) add('unsynced-draw', begin, { sequence: body });
        state = 'ground'; body = '';
      }
      continue;
    }
    if (state === 'escape') {
      if (c === 91) { state = 'csi'; body = ''; }
      else if ([93, 80, 88, 94, 95].includes(c)) {
        state = 'string'; string = ({ 93: 'OSC', 80: 'DCS', 88: 'SOS', 94: 'PM', 95: 'APC' })[c]; escaped = false;
      } else state = 'ground';
      continue;
    }
    if (c === 27) { state = 'escape'; begin = i; }
    else if (c === 7) add('bell', i);
    else if (!sync && c >= 32 && c < 127) {
      const last = events.at(-1);
      if (last?.kind === 'unsynced-text' && last.offset + last.text.length === i) last.text += String.fromCharCode(c);
      else add('unsynced-text', i, { text: String.fromCharCode(c) });
    }
  }
  return { events, state, sync };
};
