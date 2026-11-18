import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { scanFolder } from './files.js';

async function pickerExecutable(signal) {
  const source = fileURLToPath(new URL('../scripts/ChooseFolder.cs', import.meta.url));
  const hash = createHash('sha256').update('target:winexe-v2\n').update(await readFile(source)).digest('hex').slice(0,16);
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
  const resultFile = fileURLToPath(new URL(`../work/native/choose-result-${randomUUID()}.json`, import.meta.url));
  return new Promise((resolve, reject) => {
    // This helper owns a visible interactive dialog, so it must not inherit a hidden window.
    const child = spawn(executable, [resultFile], { windowsHide: false, stdio: 'ignore' });
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      unlink(resultFile).catch(() => {});
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(new Error('Folder selection cancelled.'));
    const timer = setTimeout(() => finish(new Error('Folder selection timed out. Click Browse to try again.')), 120000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', () => finish(new Error('Could not open the Windows folder picker. Restart the local service and try again.')));
    child.on('close', async code => {
      if (settled) return;
      if (code !== 0) return finish(new Error('The Windows folder picker closed unexpectedly. Click Browse to try again.'));
      try { const value = JSON.parse(await readFile(resultFile, 'utf8')); finish(null, value.path); }
      catch { finish(new Error('The folder picker returned an invalid response.')); }
    });
  });
}

export class FolderService {
  constructor(picker = chooseFolder) { this.picker = picker; this.selections = new Map(); this.busy = false; this.progress=null; }
  async scan(directory, firstLevelOnly) {
    this.progress={phase:'scanning',files:0,directories:0};
    const selection={id:randomUUID(),...await scanFolder(directory,{firstLevelOnly,signal:this.controller.signal,onProgress:p=>{this.progress={phase:'scanning',...p};}})};
    this.controller.signal.throwIfAborted();this.selections.set(selection.id,selection);
    if(this.selections.size>20)this.selections.delete(this.selections.keys().next().value);
    return this.view(selection);
  }
  async browse(signal, firstLevelOnly = true) {
    if(this.busy)throw new Error('A folder picker is already open. Finish or cancel that selection first.');
    this.busy=true;this.controller=new AbortController();this.progress={phase:'choosing'};
    const abort=()=>this.controller?.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    try {const directory=await this.picker(this.controller.signal);if(!directory||this.controller.signal.aborted)return {cancelled:true};return await this.scan(directory,firstLevelOnly);}
    catch(e){if(this.controller.signal.aborted)return {cancelled:true};throw e;}
    finally{signal?.removeEventListener('abort',abort);this.controller=null;this.busy=false;this.progress=null;}
  }
  close(){this.controller?.abort();}
  get(id){const s=this.selections.get(id);if(!s)throw new Error('Choose the folder again. This selection has expired.');return s;}
  async rescan(id, firstLevelOnly = true) {
    if(this.busy)throw new Error('A scan is already running.');
    const previous=this.get(id);this.selections.delete(id); // Invalidate before scanning, even on cancellation/failure.
    this.busy=true;this.controller=new AbortController();
    try{return await this.scan(previous.root,firstLevelOnly);}
    catch(e){if(this.controller.signal.aborted)return {cancelled:true};throw e;}
    finally{this.busy=false;this.controller=null;this.progress=null;}
  }
  view(s){return {id:s.id,root:s.root,firstLevelOnly:s.firstLevelOnly,files:s.files.map(({relativePath,name,size})=>({relativePath,name,size})),skipped:s.skipped,unscanned:s.unscanned,complete:s.complete,recoveries:s.output.recoveries,limits:s.limits};}
}
