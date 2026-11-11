import { mkdir, writeFile, readdir, lstat, realpath, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const categories = ['Study', 'Work', 'Life', 'Other'];
export const MAX_FILES = 200;
const identity = s => ({ dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs });
const metadata = s => ({ ...identity(s), size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safeName = name => typeof name === 'string' && name !== '.' && name !== '..' && !/[\\/:\0]/.test(name) && !/[. ]$/.test(name);
const changed = () => new Error('Files have changed. Rescan the folder and make a new plan.');

// Check every path component: a junction in an ancestor is also outside our boundary.
export async function directoryIdentity(directory) {
  const resolved = path.resolve(directory);
  for (let part = resolved;; part = path.dirname(part)) {
    const s = await lstat(part);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new Error('Choose a regular folder without links or junctions in its path.');
    if (part === path.dirname(part)) break;
  }
  // realpath resolves symlinks AND Windows junctions to their targets, so a link
  // anywhere in the path (including an ancestor) makes the canonical path differ.
  const canonical = await realpath(resolved);
  if (path.relative(resolved, canonical) !== '') throw new Error('Choose a regular folder without links or junctions in its path.');
  return identity(await lstat(resolved));
}
export async function scanFolder(directory) {
  const root = path.resolve(directory);
  if (root === path.parse(root).root) throw new Error('Choose a folder, not an entire drive.');
  const rootIdentity = await directoryIdentity(root);
  const files = [], skipped = [];
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const name = entry.name;
    const s = await lstat(path.join(root, name));
    // Stats.isSymbolicLink() is false for Windows junctions (mount points), but
    // Dirent.isSymbolicLink() is true for both junctions and symlinks.
    const reason = (entry.isSymbolicLink() || s.isSymbolicLink()) ? 'Link or junction' : s.isDirectory() ? 'Subfolder' : !s.isFile() ? 'Not a regular file' : s.nlink > 1 ? 'Hard-linked file' : name.startsWith('.') ? 'Dotfile' : !safeName(name) ? 'Unsupported file name' : null;
    if (reason) skipped.push({ name, reason });
    else files.push({ name, ...metadata(s) });
  }
  if (files.length > MAX_FILES) throw new Error(`This version supports up to ${MAX_FILES} files per folder. Choose a smaller folder.`);
  if (!equal(await directoryIdentity(root), rootIdentity)) throw changed();
  return { root, rootIdentity, files, skipped };
}
export async function hashFile(file, expected) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || !equal(metadata(before), metadata(expected))) throw changed();
  const handle = await open(file, 'r');
  try {
    if (!equal(metadata(await handle.stat()), metadata(before))) throw changed();
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (!equal(metadata(await handle.stat()), metadata(before)) || !equal(metadata(await lstat(file)), metadata(before))) throw changed();
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export async function prepareInventory(selection) {
  const current = await scanFolder(selection.root);
  if (!equal(current.rootIdentity, selection.rootIdentity) || !equal(current.files, selection.files)) throw changed();
  const files = [];
  for (const file of current.files) files.push({ ...file, hash: await hashFile(path.join(current.root, file.name), file) });
  return files;
}
export async function seed(root) {
  await mkdir(path.join(root, 'Inbox'), { recursive: true });
  const samples = {
    'Capstone notes.txt': 'AI Personal Assistant: interface, motion and task workflows.\n',
    'Algorithm revision.md': '# Revision plan\nGraph traversal and dynamic programming.\n',
    'Team meeting.txt': 'Demo team meeting: review weekly deliverables.\n',
    'Project budget.csv': 'Item,Amount\nDemo materials,120\n',
    'Travel checklist.txt': 'Demo data: umbrella, camera, charger.\n',
    'Shopping list.md': '# Shopping list\nMilk, fruit.\n'
  };
  for (const [name, content] of Object.entries(samples)) await writeFile(path.join(root, 'Inbox', name), content, { flag: 'wx' });
  return snapshot(root);
}
export async function snapshot(root) { return prepareInventory(await scanFolder(path.join(root, 'Inbox'))); }
export const planSchema = {
  type: 'object', additionalProperties: false, required: ['summary', 'moves'],
  properties: { summary: { type: 'string' }, moves: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['name', 'category', 'reason'],
    properties: { name: { type: 'string' }, category: { type: 'string', enum: categories }, reason: { type: 'string' } }
  } } }
};
export function validatePlan(plan, files) {
  if (!plan || typeof plan.summary !== 'string' || !Array.isArray(plan.moves) || !files.length || plan.moves.length !== files.length) throw new Error('Codex returned an incomplete plan. Please try again');
  const names = new Set(files.map(f => f.name));
  for (const move of plan.moves) {
    if (!move || !safeName(move.name) || !names.delete(move.name) || !categories.includes(move.category) || typeof move.reason !== 'string') throw new Error('The plan contains duplicate files, unknown files or invalid folders');
  }
  return plan;
}
async function absent(file) {
  try { await lstat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  throw new Error(`Destination already exists: ${file}. Nothing will be overwritten.`);
}
// No speculative rollback: on failure retain completed moves and report the exact receipt.
// Exclusive hard-link + unlink preserves file data/metadata and never overwrites a target.
// Unsupported filesystems fail safely; there is deliberately no copy/delete fallback.
export async function executePlan(root, plan, original, source = null) {
  const sourceRoot = source?.root || path.join(root, 'Inbox');
  const expectedRoot = source?.rootIdentity || await directoryIdentity(sourceRoot);
  const targetIdentity = await directoryIdentity(root);
  const receipt = { completed: [], notMoved: [...plan.moves], needsReview: [] };
  try {
    validatePlan(plan, original);
    const fresh = await scanFolder(sourceRoot);
    if (!equal(fresh.rootIdentity, expectedRoot)) throw changed();
    const current = await prepareInventory(fresh);
    if (!equal(current, original)) throw changed();
    const folderIdentities = new Map();
    // Preflight every destination before moving even the first file.
    for (const category of new Set(plan.moves.map(m => m.category))) {
      const folder = path.join(root, category);
      try { folderIdentities.set(category, await directoryIdentity(folder)); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    for (const move of plan.moves) await absent(path.join(root, move.category, move.name));
    for (const category of new Set(plan.moves.map(m => m.category))) {
      if (!equal(await directoryIdentity(root), targetIdentity)) throw changed();
      const folder = path.join(root, category);
      if (!folderIdentities.has(category)) {
        await mkdir(folder); // EEXIST is a concurrent change, not permission to reuse it.
        folderIdentities.set(category, await directoryIdentity(folder));
      }
    }
    for (const move of plan.moves) {
      const checkFolders = async () => {
        if (!equal(await directoryIdentity(sourceRoot), expectedRoot) || !equal(await directoryIdentity(root), targetIdentity) || !equal(await directoryIdentity(path.join(root, move.category)), folderIdentities.get(move.category))) throw changed();
      };
      await checkFolders();
      const file = original.find(f => f.name === move.name);
      const from = path.join(sourceRoot, move.name), to = path.join(root, move.category, move.name);
      if (await hashFile(from, file) !== file.hash) throw changed();
      await link(from, to); // Exclusive creation, same filesystem. Existing targets are never replaced.
      receipt.needsReview.push(move);
      await checkFolders();
      const linked = await lstat(from), target = await lstat(to);
      if (!linked.isFile() || linked.isSymbolicLink() || target.isSymbolicLink() || !equal(identity(linked), identity(file)) || !equal(identity(target), identity(file)) || linked.size !== file.size || linked.mtimeMs !== file.mtimeMs || await hashFile(from, linked) !== file.hash) throw changed();
      await checkFolders();
      if (!equal(metadata(await lstat(from)), metadata(linked))) throw changed();
      await unlink(from);
      receipt.needsReview.pop(); receipt.completed.push(move); receipt.notMoved.shift();
    }
    return receipt.completed;
  } catch (error) {
    receipt.notMoved = plan.moves.filter(m => !receipt.completed.includes(m) && !receipt.needsReview.includes(m));
    error.receipt = receipt;
    throw error;
  }
}
