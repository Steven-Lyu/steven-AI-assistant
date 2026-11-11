import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

// One stdio transport per application. Incoming requests and outgoing calls have separate IDs.
export class CodexClient extends EventEmitter {
  constructor() { super(); this.calls = new Map(); this.seq = 0; this.child = null; this.ready = null; }
  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open().catch(e => { this.close(); throw e; });
    return this.ready;
  }
  async open() {
    this.child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', e => this.disconnected(e));
    this.child.on('exit', () => this.disconnected(new Error('The assistant disconnected. Check your Codex sign-in and retry.')));
    this.child.stderr.on('data', () => {}); // Never forward local configuration or tokens to the browser.
    createInterface({ input: this.child.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch { /* Non-protocol diagnostics are ignored. */ }
    });
    const result = await this.call('initialize', { clientInfo: { name: 'capstone_assistant', title: 'Capstone Assistant', version: '0.1.0' } });
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
  call(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`${method} timed out`)); }, 60000);
      this.calls.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.calls.delete(id); reject(e); }
    });
  }
  reply(id, result) { this.send({ id, result }); }
  disconnected(error) {
    for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(error); }
    this.calls.clear(); this.ready = null; this.emit('disconnected', error);
  }
  close() { this.child?.kill(); this.child = null; this.ready = null; }
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
