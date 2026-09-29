const fs = require('fs'), path = require('path');
const mode = process.env.OAK_TEST_QUOTA_MODE;
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (process.env.OAK_TEST_QUOTA_METHODS) fs.appendFileSync(process.env.OAK_TEST_QUOTA_METHODS, m.method + '\n');
  if (m.method === 'initialize') {
    send({ id: m.id, result: { userAgent: 'fixture' } });
    // Codex 0.156.1's order: once its workspace-routing check succeeds, right after initialize, it sends
    // account/updated for the SAME login. The notification names no account.
    if (mode === 'routing' || mode === 'routing-mismatch') send({ method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } });
    return;
  }
  if (m.method !== 'account/rateLimits/read') return;
  if (mode === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
  if (mode === 'error') return send({ id: m.id, error: { code: -32601, message: 'unsupported' } });
  if (mode === 'switch') fs.writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { account_id: 'B' } }));
  if (mode === 'notification') send({ method: 'account/updated', params: { authMode: 'chatgpt' } });
  const window = { usedPercent: 20, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 };
  send({ id: m.id, result: { accountId: mode === 'missing' ? null : mode === 'mismatch' || mode === 'routing-mismatch' ? 'B' : 'A',
    rateLimits: { limitId: 'codex', primary: window },
    rateLimitsByLimitId: { codex: { limitId: 'codex', primary: window } } } });
});
