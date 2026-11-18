import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { CodexClient } from './codex.js';
import { TaskService } from './tasks.js';
import { FolderService } from './folders.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = new CodexClient(), service = new TaskService(client, path.join(root, 'work', 'runs'));
const token = randomBytes(32).toString('hex');
const port = Number(process.env.PORT || 4310), origin = `http://127.0.0.1:${port}`;
const streams = new Set();
const folders = new FolderService();
service.on('change', () => { for (const res of streams) res.write(`data: ${JSON.stringify(service.list())}\n\n`); });
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(res, 403, { error: 'Only local access is allowed' });
    if (req.headers.origin && ![origin, `http://localhost:${port}`].includes(req.headers.origin)) return json(res, 403, { error: 'Cross-site request denied' });
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { token, tasks: service.list() });
    if (req.method === 'GET' && url.pathname === '/api/folders/progress') return json(res,200,{busy:folders.busy,progress:folders.progress});
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      streams.add(res); res.write(`data: ${JSON.stringify(service.list())}\n\n`);
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 20000);
      req.on('close', () => { clearInterval(timer); streams.delete(res); }); return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-assistant-token'] !== token) return json(res, 403, { error: 'Session expired. Refresh this page' });
      let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 250000) throw new Error('Request too long'); }
      const body = JSON.parse(raw || '{}');
      if (url.pathname === '/api/folders/cancel') {folders.close();return json(res,200,{ok:true});}
      if(url.pathname.startsWith('/api/folders/') && service.list().some(t=>!['completed','failed','cancelled'].includes(t.status))) throw new Error('Finish or cancel your current task before changing scope.');
      if(body.firstLevelOnly!==undefined && typeof body.firstLevelOnly!=='boolean')throw new Error('Invalid scanning scope');
      if (url.pathname === '/api/folders/browse') {
        const controller = new AbortController();
        const abort = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', abort);
        try { return json(res, 200, await folders.browse(controller.signal,body.firstLevelOnly??true)); }
        finally { res.off('close', abort); }
      }
      if (url.pathname === '/api/folders/rescan') return json(res, 200, await folders.rescan(body.selectionId,body.firstLevelOnly??true));
      if (url.pathname === '/api/tasks') {
        if (typeof body.instruction !== 'string' || body.instruction.length > 2000) throw new Error('Enter a preference of up to 2000 characters');
        return json(res, 201, await service.create(body.instruction, body.sourceMode === 'sample' ? null : folders.get(body.selectionId),body.firstLevelOnly??true));
      }
      const match = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(confirm|cancel|approval|revise)$/);
      if (match) {
        if (match[2] === 'approval') { if (typeof body.allow !== 'boolean') throw new Error('Invalid decision'); service.approve(match[1], body.requestId, body.allow); }
        else if(match[2]==='revise')await service.revise(match[1],body.revision,body.changes);
        else await service[match[2]](match[1],body.revision);
        return json(res, 200, { ok: true, task: service.view(service.get(match[1])) });
      }
      return json(res, 404, { error: 'Endpoint not found' });
    }
    const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const entry = staticFiles[url.pathname];
    if (req.method !== 'GET' || !entry) return json(res, 404, { error: 'Page not found' });
    res.writeHead(200, { 'Content-Type': entry[1] + '; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' });
    res.end(await readFile(path.join(root, 'public', entry[0])));
  } catch (e) { json(res, 400, { error: e.message }); }
});
server.listen(port, '127.0.0.1', () => console.log(`Assistant ready: ${origin}`));
function stop() { folders.close(); client.close(); for (const res of streams) res.end(); server.close(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
