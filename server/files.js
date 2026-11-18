import { mkdir, writeFile, readdir, lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectOutput, assertSourceFolder } from './organization.js';
import { offlineFiles } from './windows-attributes.js';

export const MAX_FILES = 200;
export const identity = s => ({ dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs });
export const metadata = s => ({ ...identity(s), size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const safeName = name => typeof name === 'string' && name !== '.' && name !== '..' && !/[\\/:\0]/.test(name) && !/[. ]$/.test(name);
// A category is a single child folder, not an arbitrary path from the model.
// Windows device names and characters are rejected even when tests run elsewhere.
export const safeCategory = name => safeName(name) && name.length > 0 && name.length <= 255 && name.trim() === name &&
  !/[<>"|?*\x00-\x1f\x7f]/.test(name) &&
  !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name);
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
export const SCAN_LIMITS = { depth: 8, files: 200, directories: 1000, entries: 10000, milliseconds: 30000 };
export const fileKey = file => file.relativePath ?? file.name;
export const safeRelative = value => typeof value === 'string' && value.length > 0 && value.split('/').every(safeCategory) && !value.includes('\\');
export function inside(root, relative) {
  if (!safeRelative(relative)) throw new Error('Invalid relative file path');
  const resolved = path.resolve(root, ...relative.split('/'));
  if (!path.relative(root, resolved) || path.relative(root, resolved).startsWith('..') || path.isAbsolute(path.relative(root, resolved))) throw new Error('Path leaves the selected folder');
  return resolved;
}
export async function scanFolder(directory, { firstLevelOnly = true, signal, onProgress, limits = SCAN_LIMITS } = {}) {
  const root = path.resolve(directory);
  if (typeof firstLevelOnly !== 'boolean') throw new Error('Invalid scanning scope');
  if (root === path.parse(root).root) throw new Error('Choose a folder, not an entire drive.');
  await assertSourceFolder(root);
  const rootIdentity = await directoryIdentity(root), output = await inspectOutput(root);
  const files = [], skipped = [], directories = [], unscanned = [];
  const deadline = Date.now() + limits.milliseconds;
  let entriesSeen = 0;
  const check = () => { signal?.throwIfAborted(); if (Date.now() > deadline) throw new Error('Scan time limit reached'); };
  async function walk(relative = '', depth = 0) {
    const dir = relative ? inside(root, relative) : root;
    try {
      check();
      if (depth > limits.depth || directories.length >= limits.directories) throw new Error('Scan depth or folder limit reached');
      const before = await directoryIdentity(dir);
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      onProgress?.({files:files.length,directories:directories.length+1,current:relative||'.'});
      directories.push({ relativePath: relative, identity: before, entries: entries.map(e=>e.name) });
      const project = entries.some(e => ['.git','package.json','pyproject.toml','Cargo.toml','go.mod','.sln'].includes(e.name) || e.name.endsWith('.sln'));
      if (project) { skipped.push({ name: relative || '.', relativePath: relative || '.', reason: 'Linked project files — keep this folder together' }); return; }
      for (const entry of entries) {
        check();
        if (++entriesSeen > limits.entries) throw new Error('Scan entry limit reached');
        const rel = relative ? relative + '/' + entry.name : entry.name;
        if (!relative && entry.name.toLowerCase() === 'organized') {
          skipped.push({ name: entry.name, relativePath: rel, reason: output.exists ? 'Managed output folder' : 'Output folder conflict' }); continue;
        }
        if (entry.isSymbolicLink()) { skipped.push({ name: entry.name, relativePath: rel, reason: 'Link or junction' }); continue; }
        if (entry.name.startsWith('.')) { skipped.push({ name: entry.name, relativePath: rel, reason: entry.isDirectory() ? 'Dotfolder' : 'Dotfile' }); continue; }
        if (!safeCategory(entry.name)) { skipped.push({ name: entry.name, relativePath: rel, reason: 'Unsupported file name' }); continue; }
        if (entry.isDirectory()) {
          if (firstLevelOnly) skipped.push({ name: entry.name, relativePath: rel, reason: 'Subfolder — outside selected scope' });
          else if (/_files$|_assets$/i.test(entry.name)) skipped.push({ name: entry.name, relativePath: rel, reason: 'Web resources — keep related files together' });
          else await walk(rel, depth + 1);
          continue;
        }
        const s = await lstat(inside(root, rel));
        const reason = s.isSymbolicLink() ? 'Link or junction' : !s.isFile() ? 'Not a regular file' : s.nlink > 1 ? 'Hard-linked file' : /\.(html?|css|js|mjs|cjs)$/i.test(entry.name) ? 'Potential linked resources — keep related files together' : null;
        if (reason) skipped.push({ name: entry.name, relativePath: rel, reason });
        else { if (files.length >= limits.files) throw new Error('Scan file limit reached (up to ' + limits.files + ' files)'); files.push({ name: entry.name, relativePath: rel, ...metadata(s) }); }
        onProgress?.({ files: files.length, directories: directories.length, current: rel });
      }
      if (!equal(before, await directoryIdentity(dir))) throw changed();
    } catch (e) { if (signal?.aborted) throw e; unscanned.push({ relativePath: relative || '.', reason: e.message }); }
  }
  await walk(); signal?.throwIfAborted();
  const offline = await offlineFiles(files.map(f=>inside(root, f.relativePath)), signal);
  const eligible = files.filter(f => { if (!offline.has(inside(root,f.relativePath))) return true; skipped.push({ name:f.name,relativePath:f.relativePath,reason:'Cloud placeholder or offline file — not downloaded' }); return false; });
  if (!equal(await directoryIdentity(root), rootIdentity)) throw changed();
  return { root, rootIdentity, firstLevelOnly, files: eligible, skipped, directories, unscanned, complete: !unscanned.length, output, limits };
}
export async function hashFile(file, expected, { signal } = {}) {
  signal?.throwIfAborted();
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || !equal(metadata(before), metadata(expected))) throw changed();
  const handle = await open(file, 'r');
  try {
    if (!equal(metadata(await handle.stat()), metadata(before))) throw changed();
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false, signal })) { signal?.throwIfAborted(); hash.update(chunk); }
    if (!equal(metadata(await handle.stat()), metadata(before)) || !equal(metadata(await lstat(file)), metadata(before))) throw changed();
    return hash.digest('hex');
  } finally { await handle.close(); }
}
export async function prepareInventory(selection, { signal, onProgress } = {}) {
  signal?.throwIfAborted();
  if (!selection.complete) throw new Error('Scan is incomplete. Choose a smaller accessible folder and rescan.');
  const current = await scanFolder(selection.root, { firstLevelOnly: selection.firstLevelOnly, signal });
  if (!current.complete || !equal(current.rootIdentity, selection.rootIdentity) || !equal(current.files, selection.files) || !equal(current.directories, selection.directories)) throw changed();
  const files = [];
  for (const file of current.files) {
    signal?.throwIfAborted();
    files.push({ ...file, hash: await hashFile(inside(current.root, file.relativePath), file, { signal }) });
    onProgress?.({ completed: files.length, total: current.files.length });
  }
  const final = await scanFolder(selection.root,{firstLevelOnly:selection.firstLevelOnly,signal});
  if(!final.complete || !equal(final.files,current.files) || !equal(final.directories,current.directories))throw changed();
  return files;
}
export async function seed(root, { firstLevelOnly = true } = {}) {
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
  for (const folder of ['Course A', 'Course B']) {
    await mkdir(path.join(root,'Inbox',folder));
    await writeFile(path.join(root,'Inbox',folder,'IELTS Reading.txt'),'Sample reading notes from '+folder,{flag:'wx'});
  }
  return snapshot(root, { firstLevelOnly });
}
export async function snapshot(root, options) { return prepareInventory(await scanFolder(path.join(root, 'Inbox'), options)); }
export { planSchema, validatePlan, allocatePlan, executePlan } from './organization.js';
