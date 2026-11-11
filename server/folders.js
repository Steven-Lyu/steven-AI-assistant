import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { scanFolder } from './files.js';

async function pickerExecutable(signal) {
  const source = fileURLToPath(new URL('../scripts/ChooseFolder.cs', import.meta.url));
  const hash = createHash('sha256').update(await readFile(source)).digest('hex').slice(0,16);
  const output = fileURLToPath(new URL(`../work/native/choose-folder-${hash}.exe`, import.meta.url));
  try { await access(output); return output; } catch { /* Compile the project-owned helper on first use. */ }
  await mkdir(path.dirname(output), { recursive: true });
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  try {
    await promisify(execFile)(compiler, ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/reference:System.Web.Extensions.dll', `/out:${output}`, source], { windowsHide: true, timeout: 20000, signal });
  } catch { throw new Error('Could not prepare the Windows folder picker. The .NET Framework compiler is required.'); }
  return output;
}
export async function chooseFolder(signal) {
  if (process.platform !== 'win32') throw new Error('Browse requires the local Windows app service.');
  const executable = await pickerExecutable(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(new Error('Folder selection cancelled.'));
    const timer = setTimeout(() => finish(new Error('Folder selection timed out. Click Browse to try again.')), 120000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', data => { output += data.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Could not open the Windows folder picker. Restart the local service and try again.')));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new Error('The Windows folder picker closed unexpectedly. Click Browse to try again.'));
      try { const value = JSON.parse(output.replace(/^\uFEFF/, '').trim()); finish(null, value.path); }
      catch { finish(new Error('The folder picker returned an invalid response.')); }
    });
  });
}

export class FolderService {
  constructor(picker = chooseFolder) { this.picker = picker; this.selections = new Map(); this.busy = false; }
  async browse(signal) {
    if (this.busy) throw new Error('A folder picker is already open. Finish or cancel that selection first.');
    this.busy = true;
    this.controller = new AbortController();
    const abort = () => this.controller?.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const directory = await this.picker(this.controller.signal);
      if (!directory || signal?.aborted) return { cancelled: true };
      const selection = { id: randomUUID(), ...await scanFolder(directory) };
      if (signal?.aborted) return { cancelled: true };
      this.selections.set(selection.id, selection);
      // Small session-only capability store; paths from HTTP bodies are never accepted.
      if (this.selections.size > 20) this.selections.delete(this.selections.keys().next().value);
      return this.view(selection);
    } finally { signal?.removeEventListener('abort', abort); this.controller = null; this.busy = false; }
  }
  close() { this.controller?.abort(); }
  get(id) { const s = this.selections.get(id); if (!s) throw new Error('Choose the folder again. This selection has expired.'); return s; }
  async rescan(id) {
    const previous = this.get(id), selection = { id: randomUUID(), ...await scanFolder(previous.root) };
    this.selections.delete(id); this.selections.set(selection.id, selection); return this.view(selection);
  }
  view(s) { return { id: s.id, root: s.root, files: s.files.map(({ name, size }) => ({ name, size })), skipped: s.skipped }; }
}
