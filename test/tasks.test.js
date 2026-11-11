import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TaskService } from '../server/tasks.js';
import { CodexClient, approvalResponse } from '../server/codex.js';
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { scanFolder } from '../server/files.js';
class FakeClient extends EventEmitter {
  replies = []; reply(id, result) { this.replies.push({ id, result }); }
  async call() { return {}; }
}
function fixture() {
  const client = new FakeClient(), service = new TaskService(client, '.');
  const task = { id: 'task', threadId: 'thread', turnId: 'turn', status: 'running', approvals: [], events: [], messages: {}, files: [{ name: 'a' }] };
  service.tasks.set(task.id, task);
  return { client, service, task };
}
test('approval preserves RPC ID, returns decision and waits for resolved event', () => {
  const { client, service, task } = fixture();
  client.emit('request', { id: 44, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', turnId: 'turn', command: 'echo test' } });
  assert.equal(task.status, 'waiting_approval'); service.approve('task', 44, false);
  assert.deepEqual(client.replies, [{ id: 44, result: { decision: 'decline' } }]);
  assert.throws(() => service.approve('task', 44, true), /has expired/);
  client.emit('notification', { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 44 } });
  assert.equal(task.status, 'running'); assert.equal(task.approvals.length, 0);
});
test('completion invalidates outstanding approval and parses actual final output', () => {
  const { client, service, task } = fixture();
  task.approvals.push({ id: 5 });
  client.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { id: 'msg', type: 'agentMessage', text: JSON.stringify({ summary: '方案', moves: [{ name: 'a', category: 'Study', reason: '说明' }] }) } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
  assert.equal(task.status, 'waiting_confirmation'); assert.equal(task.approvals.length, 0);
  assert.throws(() => service.approve('task', 5, true));
});
test('interrupt and transport loss clear pending requests', async () => {
  const { client, service, task } = fixture(); task.approvals.push({ id: 8 });
  await service.cancel('task'); assert.equal(task.status, 'cancelled'); assert.equal(task.approvals.length, 0);
  task.status = 'waiting_approval'; task.approvals.push({ id: 9 });
  client.emit('disconnected', new Error('offline')); assert.equal(task.status, 'failed'); assert.equal(task.approvals.length, 0);
});
test('permission response grants only requested permissions for one turn', () => {
  const permissions = { network: { enabled: true } };
  assert.deepEqual(approvalResponse('item/permissions/requestApproval', { permissions }, true), { permissions, scope: 'turn' });
  assert.deepEqual(approvalResponse('item/permissions/requestApproval', { permissions }, false), { permissions: {}, scope: 'turn' });
});
test('client separates server requests from call responses with matching IDs', () => {
  const client = new CodexClient(); let requested = false, resolved = false;
  client.on('request', () => requested = true);
  client.calls.set(1, { resolve: () => resolved = true });
  client.receive({ id: 1, method: 'approval', params: {} }); assert.ok(requested); assert.equal(resolved, false);
  client.receive({ id: 1, result: {} }); assert.ok(resolved);
});

test('selected-folder task sends metadata only, uses a separate cwd, and waits for confirmation', async t => {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('work/tests/task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'selected'); await mkdir(source);
  await writeFile(path.join(source, 'notes.txt'), 'PRIVATE_CONTENT');
  const client = new FakeClient(); const calls = [];
  client.connect = async () => {};
  client.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'real-folder-thread' } };
    if (method === 'turn/start') {
      setImmediate(() => {
        client.emit('notification', { method: 'item/completed', params: { threadId: 'real-folder-thread', item: { id: 'reply', type: 'agentMessage', text: JSON.stringify({ summary: 'Plan', moves: [{ name: 'notes.txt', category: 'Study', reason: 'Notes' }] }) } } });
        client.emit('notification', { method: 'turn/completed', params: { threadId: 'real-folder-thread', turn: { status: 'completed' } } });
      });
      return { turn: { id: 'turn' } };
    }
  };
  const service = new TaskService(client, path.join(root, 'runs'));
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Task did not finish planning')), 5000);
    service.on('change', () => { const task = service.list()[0]; if (task?.status === 'waiting_confirmation' || task?.status === 'failed') { clearTimeout(timeout); resolve(task); } });
  });
  await service.create('Group my files', await scanFolder(source));
  const task = await ready;
  assert.equal(task.status, 'waiting_confirmation');
  assert.deepEqual(await readdir(source), ['notes.txt']);
  const inventory = JSON.parse(calls.find(c => c.method === 'turn/start').params.input[0].text).files;
  assert.deepEqual(inventory, [{ name: 'notes.txt', size: 15 }]);
  assert.notEqual(calls.find(c => c.method === 'thread/start').params.cwd, source);
  assert.ok(!JSON.stringify(calls).includes('PRIVATE_CONTENT'));
  await service.confirm(task.id);
  assert.equal(service.get(task.id).status, 'completed');
  assert.equal(await readFile(path.join(source, 'Study', 'notes.txt'), 'utf8'), 'PRIVATE_CONTENT');
});
