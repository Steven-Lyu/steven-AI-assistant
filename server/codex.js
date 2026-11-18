import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// One stdio transport per application. Incoming requests and outgoing calls have separate IDs.
export class CodexClient extends EventEmitter {
  constructor() { super(); this.calls = new Map(); this.seq = 0; this.child = null; this.ready = null; }
  connect() {
    if (this.ready) return this.ready;
    const pending = this.open().catch(e => { if (this.ready === pending) this.close(e); throw e; });
    this.ready = pending;
    return pending;
  }
  async open() {
    const child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.on('error', e => { if (this.child === child) this.close(e); });
    child.on('exit', () => { if (this.child === child) this.close(new Error('The assistant disconnected. Check your Codex sign-in and retry.')); });
    child.stdin.on('error', e => { if (this.child === child) this.close(e); });
    this.child.stderr.on('data', () => {}); // Never forward local configuration or tokens to the browser.
    createInterface({ input: this.child.stdout }).on('line', line => {
      if (this.child !== child) return;
      try { this.receive(JSON.parse(line)); } catch { /* Non-protocol diagnostics are ignored. */ }
    });
    const result = await this.call('initialize', { clientInfo: { name: 'capstone_assistant', title: 'Capstone Assistant', version: '0.1.0' } });
    if (this.child !== child) throw new Error('The assistant connection was closed');
    this.send({ method: 'initialized' });
    return result;
  }
  receive(message) {
    if (message.method) { this.emit(message.id !== undefined ? 'request' : 'notification', message); return; }
    const call = this.calls.get(message.id);
    if (!call) return;
    clearTimeout(call.timer); this.calls.delete(message.id);
    if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result);
  }
  send(message) {
    if (!this.child?.stdin.writable) throw new Error('The assistant is not connected');
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}, { timeoutMs = 60000 } = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.calls.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.calls.delete(id); reject(e); }
    });
  }
  reply(id, result) { this.send({ id, result }); }
  disconnected(error) {
    for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(error); }
    this.calls.clear(); this.ready = null; this.emit('disconnected', error);
  }
  close(error = new Error('The assistant connection was closed')) {
    const child = this.child;
    this.child = null; this.ready = null;
    child?.kill();
    this.disconnected(error);
  }
}

// Select from this app-server's catalog instead of inheriting the desktop/CLI model.
// A successful inference turn (not just catalog membership) verifies account access.
export async function resolveModel(client, requested = process.env.CODEX_MODEL) {
  const models = [], cursors = new Set();
  let cursor;
  do {
    const page = await client.call('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data)) throw new Error('Codex did not return a model list. Restart the service and try again.');
    models.push(...page.data.filter(m => !m.hidden && typeof m.model === 'string' && m.model));
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Codex returned an incomplete model list. Restart the service and try again.');
    cursors.add(cursor);
  } while (cursor);
  const override = requested?.trim();
  const selected = override
    ? models.find(m => m.model === override || m.id === override)
    : models.find(m => m.isDefault) || models[0];
  if (!selected) throw new Error(override
    ? `CODEX_MODEL "${override}" is not in the Codex model list. Remove CODEX_MODEL or choose a model shown by npm run check:codex, then restart the service.`
    : 'Codex has no available models. Check your Codex sign-in and restart the service.');
  return { model: selected.model, effort: selected.defaultReasoningEffort, models };
}

export function approvalResponse(method, params, allow) {
  if (method === 'item/permissions/requestApproval') return { permissions: allow ? params.permissions : {}, scope: 'turn' };
  if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) {
    const decision = allow ? 'accept' : 'decline';
    if (params.availableDecisions && !params.availableDecisions.includes(decision)) throw new Error('This decision is not available. Cancel this task instead.');
    return { decision };
  }
  throw new Error(`Unsupported permission request: ${method}`);
}
