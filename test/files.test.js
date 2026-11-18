import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, symlink, link, rename, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { scanFolder, prepareInventory, validatePlan, allocatePlan, executePlan, identity, SCAN_LIMITS } from '../server/files.js';
import { inspectOutput, splitExtension } from '../server/organization.js';

async function fixture(t, entries={'a.txt':'first','b.txt':'second'}, firstLevelOnly=false) {
  const base=path.resolve('work/tests');await mkdir(base,{recursive:true});const root=await mkdtemp(path.join(base,'nested-'));
  t.after(async()=>{assert.equal(path.dirname(root),base);await rm(root,{recursive:true,force:true});});
  for(const [relative,content] of Object.entries(entries)){const dest=path.join(root,...relative.split('/'));await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,content);}
  const selection=await scanFolder(root,{firstLevelOnly}),files=await prepareInventory(selection);
  const proposed={summary:'Organize by subject',moves:files.map(f=>({relativePath:f.relativePath,category:'English',action:'move',assessment:'reclassify',reason:'Subject inferred from name'}))};
  return {root,selection,files,proposed,plan:await allocatePlan(root,proposed,files)};
}
const apply=f=>executePlan(f.root,f.plan,f.files,f.selection);
const destination=(f,name,category='English')=>path.join(f.root,'Organized',category,name);

test('scope defaults to first level and recursion includes nested files by relative path',async t=>{
  const f=await fixture(t,{'top.txt':'a','one/two/notes.txt':'b'});
  const shallow=await scanFolder(f.root);assert.equal(shallow.firstLevelOnly,true);assert.deepEqual(shallow.files.map(f=>f.relativePath),['top.txt']);assert.match(shallow.skipped[0].reason,/Subfolder/);
  assert.deepEqual(f.files.map(f=>f.relativePath),['one/two/notes.txt','top.txt']);
});
test('duplicate IELTS files flatten into stable numbered destinations and retain distinct contents',async t=>{
  const f=await fixture(t,{'files2/IELTS Reading.docx':'two','files1/IELTS Reading.docx':'one'});
  assert.deepEqual(f.plan.moves.map(m=>m.targetName),['IELTS Reading 1.docx','IELTS Reading 2.docx']);
  assert.deepEqual((await readdir(f.root)).sort(),['files1','files2']);
  await apply(f);assert.equal(await readFile(destination(f,'IELTS Reading 1.docx'),'utf8'),'one');assert.equal(await readFile(destination(f,'IELTS Reading 2.docx'),'utf8'),'two');
  assert.deepEqual(await readdir(path.join(f.root,'files1')),[]);
  const scan=await scanFolder(f.root,{firstLevelOnly:false});assert.equal(scan.files.length,0);assert.ok(scan.skipped.some(x=>x.reason==='Managed output folder'));
  await assert.rejects(scanFolder(path.join(f.root,'Organized')),/inside a managed output/);
  await assert.rejects(scanFolder(path.join(f.root,'Organized','English')),/inside a managed output/);
});
test('reserve existing numbers and compare case-insensitively before assigning duplicate groups',async t=>{
  const f=await fixture(t,{'a/Notes.txt':'a','b/notes.txt':'b','c/Notes.txt':'c','Notes 1.txt':'d'});
  assert.equal(f.plan.moves.find(m=>m.relativePath==='Notes 1.txt').targetName,'Notes 1.txt');
  const names=f.plan.moves.map(m=>m.targetName.toLowerCase());assert.deepEqual([...names].sort(),['notes 1.txt','notes 2.txt','notes 3.txt','notes 4.txt']);
  const reversed={...f.proposed,moves:[...f.proposed.moves].reverse()};assert.deepEqual((await allocatePlan(f.root,reversed,f.files)).moves,f.plan.moves);
});
test('same names in distinct categories keep their names; case variants share one category',async t=>{
  const f=await fixture(t,{'a/notes.txt':'a','b/notes.txt':'b'});f.proposed.moves[1].category='Mathematics';
  let plan=await allocatePlan(f.root,f.proposed,f.files);assert.ok(plan.moves.every(m=>m.targetName==='notes.txt'));
  f.proposed.moves[1].category='english';plan=await allocatePlan(f.root,f.proposed,f.files);assert.ok(plan.moves.every(m=>m.category==='English'));assert.equal(plan.counts.renamed,2);
});
test('compound extensions, extensionless names and original numbers are preserved',()=>{
  assert.deepEqual(splitExtension('backup.tar.gz'),['backup','.tar.gz']);assert.deepEqual(splitExtension('notes'),['notes','']);assert.deepEqual(splitExtension('notes 2.docx'),['notes 2','.docx']);
});
test('existing files and directories reserve target names without overwrite',async t=>{
  const f=await fixture(t,{'notes.txt':'old'});await apply(f);
  await mkdir(destination(f,'notes 1.txt'));await writeFile(path.join(f.root,'notes.txt'),'new');
  const selection=await scanFolder(f.root),files=await prepareInventory(selection),plan=await allocatePlan(f.root,{summary:'Next',moves:[{...f.proposed.moves[0]}]},files);
  assert.equal(plan.moves[0].targetName,'notes 2.txt');await executePlan(f.root,plan,files,selection);
  assert.equal(await readFile(destination(f,'notes.txt'),'utf8'),'old');assert.equal(await readFile(destination(f,'notes 2.txt'),'utf8'),'new');
});
test('unknown sources, duplicate relative paths, traversal and invalid categories are rejected',async t=>{
  const f=await fixture(t);
  for(const patch of [{relativePath:'../secret'},{relativePath:'b.txt'},{category:'CON'},{category:'Computer Science/AI'},{category:''},{relativePath:'/absolute'}]){const p=structuredClone(f.proposed);Object.assign(p.moves[0],patch);assert.throws(()=>validatePlan(p,f.files));}
});
test('review and excluded files never move without an explicit resolved final plan',async t=>{
  const f=await fixture(t);f.proposed.moves[0].action='review';f.proposed.moves[0].category='';f.plan=await allocatePlan(f.root,f.proposed,f.files);await assert.rejects(apply(f),/Resolve review/);
  f.proposed.moves.forEach(m=>m.action='keep');f.plan=await allocatePlan(f.root,f.proposed,f.files);assert.deepEqual(await apply(f),[]);assert.deepEqual(await readdir(f.root),['a.txt','b.txt']);
});
test('editing categories or exclusions recalculates names before approval',async t=>{
  const f=await fixture(t,{'a/notes.txt':'a','b/notes.txt':'b'});f.proposed.moves[0].action='keep';f.plan=await allocatePlan(f.root,f.proposed,f.files);assert.equal(f.plan.moves[1].targetName,'notes.txt');await apply(f);assert.equal(await readFile(path.join(f.root,'a','notes.txt'),'utf8'),'a');
});
test('overlong target paths block the preview and can be fixed by a target name edit',async t=>{
  const f=await fixture(t);f.proposed.moves[0].requestedName='x'.repeat(240)+'.txt';f.plan=await allocatePlan(f.root,f.proposed,f.files);assert.ok(f.plan.moves[0].blocker);await assert.rejects(apply(f),/Resolve review/);
  f.proposed.moves[0].requestedName='short.txt';f.plan=await allocatePlan(f.root,f.proposed,f.files);assert.equal(f.plan.counts.blocked,0);
});
test('a source edit or a newly added nested file invalidates the plan',async t=>{
  const f=await fixture(t,{'one/a.txt':'a'});await writeFile(path.join(f.root,'one','a.txt'),'changed');await assert.rejects(apply(f),/Files have changed/);
  await assert.rejects(prepareInventory(f.selection),/Files have changed/);
});
test('new source entries invalidate a preview even when excluded from the model',async t=>{
  const f=await fixture(t);await writeFile(path.join(f.root,'.new'),'new');await assert.rejects(apply(f),/Files have changed/);
});
test('replaced nested parents invalidate all moves',async t=>{
  const f=await fixture(t,{'one/a.txt':'a'});await rename(path.join(f.root,'one'),path.join(f.root,'old'));await mkdir(path.join(f.root,'one'));await writeFile(path.join(f.root,'one','a.txt'),'a');await assert.rejects(apply(f),/Files have changed/);
});
test('an unrecognized Organized directory or file blocks scanning',async t=>{
  const f=await fixture(t);await mkdir(path.join(f.root,'Organized'));await assert.rejects(scanFolder(f.root),/not a recognized/);
});
test('post-preview target occupation stops without silently renumbering',async t=>{
  const f=await fixture(t,{'old.txt':'old'});await apply(f);await writeFile(path.join(f.root,'new.txt'),'new');
  const selection=await scanFolder(f.root),files=await prepareInventory(selection);const plan=await allocatePlan(f.root,{summary:'New',moves:[{...f.proposed.moves[0],relativePath:'new.txt'}]},files);
  await writeFile(destination(f,'new.txt'),'occupied');await assert.rejects(executePlan(f.root,plan,files,selection),/Destination changed/);assert.equal(await readFile(path.join(f.root,'new.txt'),'utf8'),'new');assert.equal(await readFile(destination(f,'new.txt'),'utf8'),'occupied');
});
test('junctions and hard links are skipped, junction output is rejected',async t=>{
  const f=await fixture(t);const outside=path.join(f.root,'outside');await mkdir(outside);await symlink(outside,path.join(f.root,'jump'),process.platform==='win32'?'junction':'dir');await link(path.join(f.root,'a.txt'),path.join(f.root,'alias.txt'));
  const scan=await scanFolder(f.root,{firstLevelOnly:false});assert.ok(scan.skipped.some(x=>x.reason==='Link or junction'));assert.equal(scan.skipped.filter(x=>x.reason==='Hard-linked file').length,2);
  await symlink(outside,path.join(f.root,'Organized'),process.platform==='win32'?'junction':'dir');await assert.rejects(scanFolder(f.root),/conflicts/);
});
test('dot directories and recognized linked projects are excluded as groups',async t=>{
  const f=await fixture(t,{'project/package.json':'{}','project/a.txt':'a','.private/hidden.txt':'h','web/index.html':'html','visible.txt':'v'});
  assert.deepEqual(f.files.map(f=>f.relativePath),['visible.txt']);assert.ok(f.selection.skipped.some(x=>x.reason.includes('project')));assert.ok(f.selection.skipped.some(x=>x.reason==='Dotfolder'));
});
test('limits produce an incomplete scan with explicit unscanned scope',async t=>{
  const f=await fixture(t,{'a/b/c.txt':'c','top.txt':'t'});const scan=await scanFolder(f.root,{firstLevelOnly:false,limits:{...SCAN_LIMITS,depth:1}});assert.equal(scan.complete,false);assert.equal(scan.unscanned[0].relativePath,'a/b');await assert.rejects(prepareInventory(scan),/incomplete/);
});
test('scan and hashing cancellation keep sources intact',async t=>{
  const f=await fixture(t),controller=new AbortController();controller.abort();await assert.rejects(scanFolder(f.root,{signal:controller.signal}),{name:'AbortError'});
  const hashing=new AbortController();await assert.rejects(prepareInventory(f.selection,{signal:hashing.signal,onProgress:()=>hashing.abort()}),{name:'AbortError'});assert.equal((await readdir(f.root)).length,2);
});
test('content is streamed for large files',async t=>{
  const f=await fixture(t);const h=await open(path.join(f.root,'large.bin'),'w');await h.truncate(32*1024*1024);await h.close();const files=await prepareInventory(await scanFolder(f.root));assert.match(files.find(f=>f.name==='large.bin').hash,/^[a-f0-9]{64}$/);
});
test('persisted ownership survives reimport; interrupted records reconcile without replay',async t=>{
  const f=await fixture(t,{'a.txt':'a'});await apply(f);
  const records=path.join(f.root,'Organized','.records'),name=(await readdir(records))[0],log=path.join(records,name);const lines=(await readFile(log,'utf8')).trim().split('\n');await writeFile(log,lines.slice(0,-1).join('\n')+'\n');
  const output=await inspectOutput(f.root);assert.equal(output.recoveries[0].completed.length,1);assert.equal(output.recoveries[0].needsReview.length,0);assert.equal((await scanFolder(f.root,{firstLevelOnly:false})).files.length,0);
  await link(destination(f,'a.txt'),path.join(f.root,'a.txt'));const ambiguous=await inspectOutput(f.root);assert.equal(ambiguous.recoveries[0].needsReview.length,1);await assert.rejects(allocatePlan(f.root,{summary:'None',moves:[]},[]),/interrupted move needs review/);
});
test('Windows locked-file failure preserves receipt and durable execution record',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t),second=path.join(f.root,'b.txt');
  const child=spawn('powershell.exe',['-NoProfile','-Command','$f = [IO.File]::Open($env:CAPSTONE_TEST_LOCK,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine("ready"); [Console]::ReadLine() | Out-Null; $f.Dispose()'],{windowsHide:true,env:{...process.env,CAPSTONE_TEST_LOCK:second}});
  try{await once(child.stdout,'data');await assert.rejects(apply(f),e=>{assert.equal(e.receipt.completed.length,1);assert.equal(e.receipt.notMoved.length+e.receipt.needsReview.length,1);return true;});assert.equal(await readFile(second,'utf8'),'second');assert.equal((await readdir(path.join(f.root,'Organized','.records'))).length,1);}
  finally{child.stdin.end('done\n');await once(child,'close');}
});

test('single-level execution leaves all subfolder files untouched',async t=>{
  const f=await fixture(t,{'top.txt':'top','nested/notes.txt':'nested'},true);await apply(f);
  assert.equal(await readFile(path.join(f.root,'nested','notes.txt'),'utf8'),'nested');assert.equal(await readFile(destination(f,'top.txt'),'utf8'),'top');assert.equal(f.plan.moves.length,1);
});
test('identical content is kept separately and Unicode paths survive scanning',async t=>{
  const f=await fixture(t,{'资料一/笔记.txt':'相同内容','资料二/笔记.txt':'相同内容'});assert.equal(f.files[0].hash,f.files[1].hash);await apply(f);assert.equal((await readdir(path.join(f.root,'Organized','English'))).length,2);
});
