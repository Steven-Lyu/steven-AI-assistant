import { CodexClient, resolveModel } from '../server/codex.js';
const client = new CodexClient();
client.on('disconnected', () => {});
try {
  const server = await client.connect();
  const account = await client.call('account/read', { refreshToken: false });
  const selection = await resolveModel(client, '');
  console.log(JSON.stringify({ connected: true, server, loggedIn: Boolean(account.account), defaultModel: selection.model, configuredOverride: process.env.CODEX_MODEL || null, models: selection.models.map(m => m.model), note: 'Catalog only; a completed plan verifies model access.' }, null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { client.close(); }
