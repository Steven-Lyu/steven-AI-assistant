import { CodexClient } from '../server/codex.js';
const client = new CodexClient();
client.on('disconnected', () => {});
try {
  const server = await client.connect();
  const account = await client.call('account/read', { refreshToken: false });
  const models = await client.call('model/list', {});
  console.log(JSON.stringify({ connected: true, server, loggedIn: Boolean(account.account), models: models.data?.map(m => m.id) }, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { client.close(); }
