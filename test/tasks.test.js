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
  close() { this.closed = (this.closed || 0) + 1; this.emit('disconnected', new Error('closed')); }
}
function fixture() {
  const client = new FakeClient(), service = new TaskService(client, '.', { cancellation: 20 });
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

test('cancel publishes immediately and forces a close when interrupt never responds', async () => {
  const { client, service, task } = fixture();
  client.call = () => new Promise(() => {});
  const pending = service.cancel(task.id);
  assert.equal(task.status, 'cancelling');
  await pending;
  assert.equal(task.status, 'cancelled'); assert.equal(client.closed, 1);
  client.emit('notification', { method: 'turn/completed', params: { threadId: task.threadId, turn: { status: 'completed' } } });
  assert.equal(task.status, 'cancelled'); assert.equal(task.plan, undefined);
});
test('interrupt acknowledgment alone does not complete cancellation; terminal event does', async () => {
  const { client, service, task } = fixture();
  const pending = service.cancel(task.id);
  await Promise.resolve();
  assert.equal(task.status, 'cancelling');
  client.emit('notification', { method: 'turn/completed', params: { threadId: task.threadId, turn: { status: 'interrupted' } } });
  await pending;
  assert.equal(task.status, 'cancelled'); assert.equal(client.closed, undefined);
});
test('cancel interrupts file checking before a turn exists and rejects late approvals', async () => {
  const { client, service, task } = fixture();
  task.status = 'submitted'; delete task.turnId; task.controller = new AbortController();
  client.send = message => client.replies.push(message);
  await service.cancel(task.id);
  assert.equal(task.controller.signal.aborted, true);
  assert.equal(task.status, 'cancelled'); assert.equal(client.closed, 1);
  client.emit('request', { id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: task.threadId } });
  assert.equal(client.replies[0].error.code, -32601);
});
test('stage timeout stops the model and yields a retryable failure', async () => {
  const { client, service, task } = fixture();
  const failed = new Promise(resolve => service.on('change', () => { if(task.status === 'failed')resolve(); }));
  service.phase(task, 'planning', 'Planning from file names', 10);
  await failed;
  assert.match(task.error, /timed out/); assert.equal(client.closed, 1);
});
test('non-retryable model error stops waiting even without turn/completed', () => {
  const { client, service, task } = fixture();
  service.notification({ method: 'error', params: { threadId: task.threadId, willRetry: false, error: { message: 'Model unavailable' } } });
  assert.equal(task.status, 'failed'); assert.equal(task.error, 'Model unavailable'); assert.equal(client.closed, 1);
});
test('retryable errors stay active and recovery restores the planning stage', () => {
  const { service, task } = fixture();
  service.notification({ method: 'error', params: { threadId: task.threadId, willRetry: true, error: { message: 'Retrying' } } });
  assert.equal(task.status, 'running'); assert.equal(task.phase, 'retrying');
  service.notification({ method: 'item/started', params: { threadId: task.threadId, item: { type: 'agentMessage' } } });
  assert.equal(task.phase, 'planning'); assert.equal(task.notice, null);
});
test('transport close rejects outstanding RPC calls immediately and clears timers', async () => {
  const client = new CodexClient(); let killed = false;
  client.child = { stdin: { writable: true, write() {} }, kill() { killed = true; } };
  const pending = client.call('turn/interrupt');
  client.close();
  await assert.rejects(pending, /connection was closed/);
  assert.equal(client.calls.size, 0); assert.equal(killed, true);
});
test('completion invalidates outstanding approval and rejects an invalid final output', () => {
  const { client, service, task } = fixture();
  task.approvals.push({ id: 5 });
  client.emit('notification', { method: 'item/completed', params: { threadId: 'thread', item: { id: 'msg', type: 'agentMessage', text: JSON.stringify({ summary: '方案', moves: [{ name: 'a', category: 'Study', reason: '说明' }] }) } } });
  client.emit('notification', { method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
  assert.equal(task.status, 'failed'); assert.equal(task.approvals.length, 0);
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
  await mkdir(path.join(source,'Course'));
  await writeFile(path.join(source,'Course','notes.txt'),'PRIVATE_CONTENT');
  const client = new FakeClient(); const calls = [];
  client.connect = async () => {};
  client.call = async (method, params) => {
    calls.push({ method, params });
    if (method === 'model/list') return { data: [{ model: 'test-available-model', isDefault: true, defaultReasoningEffort: 'low' }] };
    if (method === 'thread/start') return { thread: { id: 'real-folder-thread' } };
    if (method === 'turn/start') {
      setImmediate(() => {
        client.emit('notification', { method: 'item/completed', params: { threadId: 'real-folder-thread', item: { id: 'reply', type: 'agentMessage', text: JSON.stringify({ summary: 'Plan', moves: [{ relativePath: 'Course/notes.txt', category: 'Mathematics', action:'move', assessment:'reclassify', reason: 'Subject notes' }] }) } } });
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
  const selection=await scanFolder(source,{firstLevelOnly:false});
  await assert.rejects(service.create('Group my files',selection),/scope changed/);
  await service.create('Group my files',selection,false);
  const task = await ready;
  assert.equal(task.status, 'waiting_confirmation');
  assert.deepEqual(await readdir(source), ['Course']);
  const inventory = JSON.parse(calls.find(c => c.method === 'turn/start').params.input[0].text).files;
  assert.deepEqual(inventory, [{ relativePath:'Course/notes.txt', name: 'notes.txt', size: 15 }]);
  assert.equal(calls.find(c => c.method === 'turn/start').params.outputSchema.properties.moves.items.properties.category.enum, undefined);
  assert.equal(task.plan.moves[0].category, 'Mathematics');
  assert.notEqual(calls.find(c => c.method === 'thread/start').params.cwd, source);
  assert.equal(calls.find(c => c.method === 'thread/start').params.model, 'test-available-model');
  assert.equal(calls.find(c => c.method === 'turn/start').params.model, 'test-available-model');
  assert.equal(calls.find(c => c.method === 'turn/start').params.effort, 'low');
  assert.ok(!JSON.stringify(calls).includes('PRIVATE_CONTENT'));
  await assert.rejects(service.confirm(task.id,'stale'),/plan has changed/);
  await service.revise(task.id,task.plan.revision,[{relativePath:'Course/notes.txt',category:'Computer Science',action:'move',requestedName:'CS notes.txt'}]);
  assert.equal(service.get(task.id).plan.moves[0].targetName,'CS notes.txt');
  await service.confirm(task.id,service.get(task.id).plan.revision);
  assert.equal(service.get(task.id).status, 'completed');
  assert.equal(await readFile(path.join(source, 'Organized', 'Computer Science', 'CS notes.txt'), 'utf8'), 'PRIVATE_CONTENT');
});
