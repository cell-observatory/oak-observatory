// Synthetic Claude Code delivery records; command identity is independent of its words.
const at = s => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString();
const ask = (text, s, uuid, extra = {}) => ({ type: 'user', timestamp: at(s), uuid, message: { role: 'user', content: text }, ...extra });
const queued = (text, s, id, extra = {}) => ({ type: 'attachment', uuid: `attachment-${id}`, timestamp: at(s), attachment: {
  type: 'queued_command', prompt: text, source_uuid: id, delivery_id: `delivery-${id}`, commandMode: 'prompt', origin: { kind: 'human' }, ...extra,
} });
const remove = (text, s, id, reason = 'absorbed_mid_turn') => ({ type: 'queue-operation', operation: 'remove', content: text,
  timestamp: at(s), commandUuid: id, deliveryId: `delivery-${id}`, reason });
const blob = (text, s) => ({ type: 'api-request-blob', timestamp: at(s), message: { role: 'user', content: [
  { type: 'tool_result', tool_use_id: 'read-1', content: 'replayed output' },
  { type: 'text', text: `The user sent a new message while you were working:\n${text}` },
] } });
const answer = (text, s) => ({ type: 'assistant', timestamp: at(s), message: { id: `answer-${s}`, role: 'assistant', content: [{ type: 'text', text }] } });
module.exports = { at, ask, queued, remove, blob, answer };
