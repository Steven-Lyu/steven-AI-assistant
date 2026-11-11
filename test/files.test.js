import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm, symlink, link, rename, open } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { seed, validatePlan, executePlan, scanFolder, prepareInventory } from '../server/files.js';

async function fixture(t) {
  await mkdir('work/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('work/tests/capstone-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = await seed(root);
  return { root, files, plan: { summary: '测试方案', moves: files.map(f => ({ name: f.name, category: 'Study', reason: '测试' })) } };
}
test('confirmed plan moves actual files without changing contents', async t => {
  const { root, files, plan } = await fixture(t);
  const before = await readFile(path.join(root, 'Inbox', files[0].name));
  await executePlan(root, plan, files);
  assert.deepEqual(await readdir(path.join(root, 'Inbox')), []);
  assert.deepEqual(await readFile(path.join(root, 'Study', files[0].name)), before);
});
test('rejects invented paths, duplicate names and unknown categories', async t => {
  const { files, plan } = await fixture(t);
  for (const change of [{ name: '../secret' }, { name: plan.moves[1].name }, { category: '../outside' }]) {
    const invalid = structuredClone(plan); Object.assign(invalid.moves[0], change);
    assert.throws(() => validatePlan(invalid, files));
  }
});
test('changed source invalidates a confirmed plan', async t => {
  const { root, files, plan } = await fixture(t);
  await writeFile(path.join(root, 'Inbox', files[0].name), 'changed');
  await assert.rejects(executePlan(root, plan, files), /Files have changed/);
  assert.equal((await readdir(path.join(root, 'Inbox'))).length, 6);
});
test('destination collision is caught before any file moves', async t => {
  const { root, files, plan } = await fixture(t);
  await mkdir(path.join(root, 'Study'));
  const target = path.join(root, 'Study', files[2].name); await writeFile(target, 'keep');
  await assert.rejects(executePlan(root, plan, files), /Destination already exists/);
  assert.equal(await readFile(target, 'utf8'), 'keep');
  assert.equal((await readdir(path.join(root, 'Inbox'))).length, 6);
});

async function realFixture(t) {
  const { root } = await fixture(t);
  const folder = path.join(root, 'Selected folder'); await mkdir(folder);
  await writeFile(path.join(folder, 'a 学习.txt'), 'private content, never included in model input');
  await writeFile(path.join(folder, 'b 工作.csv'), 'item,value\nbook,20');
  const selection = await scanFolder(folder), files = await prepareInventory(selection);
  const plan = { summary: 'Organize', moves: files.map(f => ({ name: f.name, category: 'Study', reason: 'Test' })) };
  return { root, folder, selection, files, plan };
}
test('real folder moves first-level files into child folders, preserving content and skipped items', async t => {
  const { folder, selection, files, plan } = await realFixture(t);
  await mkdir(path.join(folder, 'Nested')); await writeFile(path.join(folder, 'Nested', 'keep.txt'), 'keep');
  await writeFile(path.join(folder, '.hidden'), 'keep');
  const scan = await scanFolder(folder);
  assert.deepEqual(scan.skipped.map(x => x.reason).sort(), ['Dotfile','Subfolder']);
  await executePlan(folder, plan, files, selection);
  assert.equal(await readFile(path.join(folder, 'Study', files[0].name), 'utf8'), 'private content, never included in model input');
  assert.equal(await readFile(path.join(folder, 'Nested', 'keep.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(folder, '.hidden'), 'utf8'), 'keep');
});
test('added files invalidate the inventory before planning or moving', async t => {
  const { folder, selection, files, plan } = await realFixture(t);
  await writeFile(path.join(folder, 'new.txt'), 'new');
  await assert.rejects(prepareInventory(selection), /Files have changed/);
  await assert.rejects(executePlan(folder, plan, files, selection), e => e.receipt.completed.length === 0 && e.receipt.notMoved.length === 2);
});
test('replaced source folder is rejected even with matching file names', async t => {
  const { folder, selection, files, plan } = await realFixture(t);
  await rename(folder, folder + '-old'); await mkdir(folder);
  for (const file of files) await writeFile(path.join(folder, file.name), 'replacement');
  await assert.rejects(executePlan(folder, plan, files, selection), /Files have changed/);
});
test('junction roots and destinations are rejected; linked entries are skipped', async t => {
  const { root, folder, selection, files, plan } = await realFixture(t);
  const outside = path.join(root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(folder, 'Study'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(executePlan(folder, plan, files, selection), /links or junctions/);
  assert.deepEqual(await readdir(outside), []);
  await assert.rejects(scanFolder(path.join(folder, 'Study')), /links or junctions/);
  assert.equal((await scanFolder(folder)).skipped[0].reason, 'Link or junction');
});
test('hard-linked files are excluded', async t => {
  const { folder, files } = await realFixture(t);
  await link(path.join(folder, files[0].name), path.join(folder, 'alias.txt'));
  assert.equal((await scanFolder(folder)).files.length, 1);
  assert.equal((await scanFolder(folder)).skipped.filter(f => f.reason === 'Hard-linked file').length, 2);
});
test('streamed inventory supports large files without changing the file', async t => {
  const { folder } = await realFixture(t);
  const handle = await open(path.join(folder, 'large.bin'), 'w'); await handle.truncate(32 * 1024 * 1024); await handle.close();
  const files = await prepareInventory(await scanFolder(folder));
  assert.equal(files.find(f => f.name === 'large.bin').size, 32 * 1024 * 1024);
  assert.match(files.find(f => f.name === 'large.bin').hash, /^[a-f0-9]{64}$/);
});
test('empty and oversized folders have explicit outcomes', async t => {
  const { root } = await fixture(t); const folder = path.join(root, 'empty'); await mkdir(folder);
  assert.equal((await scanFolder(folder)).files.length, 0);
  await Promise.all(Array.from({ length: 201 }, (_, i) => writeFile(path.join(folder, `${i}.txt`), 'x')));
  await assert.rejects(scanFolder(folder), /up to 200/);
});
test('Windows locked-file failure reports completed and remaining moves', { skip: process.platform !== 'win32' }, async t => {
  const { folder, selection, files, plan } = await realFixture(t);
  const second = path.join(folder, files[1].name);
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', '$f = [IO.File]::Open($env:CAPSTONE_TEST_LOCK, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); [Console]::WriteLine("ready"); [Console]::ReadLine() | Out-Null; $f.Dispose()'], { windowsHide: true, env: { ...process.env, CAPSTONE_TEST_LOCK: second } });
  try {
    await once(child.stdout, 'data');
    await assert.rejects(executePlan(folder, plan, files, selection), e => {
      assert.equal(e.receipt.completed.length, 1);
      assert.equal(e.receipt.needsReview.length + e.receipt.notMoved.length, 1);
      return true;
    });
    assert.equal(await readFile(second, 'utf8'), 'item,value\nbook,20');
  } finally { child.stdin.end('done\n'); await once(child, 'close'); }
});
