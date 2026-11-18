import { spawn } from 'node:child_process';

// Query metadata only. Do not open a cloud placeholder and cause hydration.
export async function offlineFiles(paths, signal) {
  if (process.platform !== 'win32' || !paths.length) return new Set();
  return new Promise((resolve, reject) => {
    const command = '[Console]::InputEncoding = [Text.UTF8Encoding]::new(); [Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $ErrorActionPreference="Stop"; $paths = [Console]::In.ReadToEnd() | ConvertFrom-Json; $result = @(); foreach($p in $paths) { $a = [int][IO.File]::GetAttributes($p); if (($a -band 0x441000) -ne 0) { $result += $p } }; ConvertTo-Json -Compress -InputObject @($result)';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, signal, stdio: ['pipe','pipe','pipe'] });
    let out = '', err = '';
    const timeout = setTimeout(()=>child.kill(), 10000);
    child.stdout.on('data', data=>out+=data); child.stderr.on('data', data=>err+=data);
    child.on('error', e=>{clearTimeout(timeout); reject(e);});
    child.on('close', code=>{ clearTimeout(timeout); if(code!==0) return reject(new Error('Could not check offline file attributes. Rescan before planning. ' + err.slice(0,200))); try {resolve(new Set(JSON.parse(out)));} catch(e){reject(e);} });
    child.stdin.on('error', ()=>{}); child.stdin.end(JSON.stringify(paths));
  });
}
