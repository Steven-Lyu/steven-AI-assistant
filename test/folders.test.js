import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { FolderService } from '../server/folders.js';

test('picker cancellation creates no selection; concurrent picker is rejected', async () => {
  let complete;
  const service = new FolderService(() => new Promise(resolve => { complete = resolve; }));
  const pending = service.browse();
  await assert.rejects(service.browse(), /already open/);
  complete(null); assert.deepEqual(await pending, { cancelled: true });
  assert.equal(service.selections.size, 0); assert.equal(service.busy, false);
});
test('selection IDs are required and rescan replaces the capability and inventory', async t => {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('work/tests/picker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new FolderService(async () => root);
  assert.throws(() => service.get(root), /expired/);
  const first = await service.browse(); assert.equal(first.files.length, 0);
  await writeFile(path.join(root, 'new.txt'), 'private');
  const next = await service.rescan(first.id);
  assert.equal(next.files.length, 1); assert.notEqual(next.id, first.id);
  assert.throws(() => service.get(first.id), /expired/);
  assert.deepEqual(Object.keys(next.files[0]), ['name','size']);
});
