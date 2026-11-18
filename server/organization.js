import { mkdir, readdir, lstat, readFile, writeFile, open, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { directoryIdentity, identity, metadata, equal, safeCategory, safeRelative, inside, fileKey, scanFolder, prepareInventory, hashFile } from './files.js';

const OUTPUT = 'Organized', MARKER = '.personal-ai.json', RECORDS = '.records';
const sort = (a,b) => a < b ? -1 : a > b ? 1 : 0;
const folded = value => value.toLowerCase();
async function statOrNull(file) { try { return await lstat(file); } catch(e) { if(e.code==='ENOENT')return null; throw e; } }
async function readRegular(file, max = 2000000) {
  const s = await lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > max) throw new Error('Invalid application output metadata: ' + file);
  return readFile(file,'utf8');
}
export async function assertSourceFolder(root) {
  for(let current=path.resolve(root);;current=path.dirname(current)) {
    const markerPath=path.join(current,MARKER);
    if(await statOrNull(markerPath)) {
      let marker;
      try{marker=JSON.parse(await readRegular(markerPath,4096));}
      catch{throw new Error('Output ownership metadata is unreadable. Choose the original source folder.');}
      if(marker.app==='personal-ai-organizer')throw new Error('This folder is inside a managed output directory. Choose the original source folder; output reclassification is not enabled.');
    }
    if(current===path.dirname(current))break;
  }
}
export async function inspectOutput(root) {
  const entries = await readdir(root, {withFileTypes:true});
  const entry = entries.find(e=>folded(e.name)===folded(OUTPUT));
  if (!entry) return { exists:false, folders:[], targets:[], recoveries:[] };
  const output = path.join(root,entry.name);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Organized conflicts with a file or link. Choose another folder or resolve the conflict.');
  const outputIdentity = await directoryIdentity(output);
  let marker;
  try { marker = JSON.parse(await readRegular(path.join(output,MARKER), 4096)); }
  catch { throw new Error('Organized already exists and is not a recognized Personal AI output folder. Resolve this name conflict before organizing.'); }
  if (marker.app !== 'personal-ai-organizer' || marker.version !== 1 || !equal(marker.root,await directoryIdentity(root)) || !equal(marker.output,outputIdentity)) throw new Error('Organized ownership or directory identity changed. Resolve this conflict before organizing.');
  const folders=[], targets=[];
  for (const e of (await readdir(output,{withFileTypes:true})).sort((a,b)=>sort(a.name,b.name))) {
    if (e.name===MARKER || e.name===RECORDS) continue;
    if (!safeCategory(e.name) || !e.isDirectory() || e.isSymbolicLink()) throw new Error('Unsupported item in Organized: '+e.name);
    const dir = path.join(output,e.name), dirIdentity=await directoryIdentity(dir);
    folders.push({name:e.name,identity:dirIdentity});
    for(const item of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>sort(a.name,b.name))) {
      const s=await lstat(path.join(dir,item.name));
      targets.push({category:e.name,name:item.name, ...metadata(s), kind:item.isSymbolicLink()?'link':s.isDirectory()?'directory':'file'});
      if(targets.length>10000)throw new Error('Organized contains too many entries to check safely.');
    }
  }
  const recoveries = await recoverRecords(root, output);
  return {exists:true,identity:outputIdentity,folders,targets,recoveries};
}
async function recoverRecords(root, output) {
  const directory=path.join(output,RECORDS);
  if(!await statOrNull(directory))return [];
  await directoryIdentity(directory);
  const names=(await readdir(directory)).sort();
  if(names.length>1000)throw new Error('Too many execution records. Archive old records before continuing.');
  const reports=[];
  for(const name of names) {
    if(!/^[a-f0-9-]+\.jsonl$/.test(name))throw new Error('Unexpected execution record');
    const raw=await readRegular(path.join(directory,name));
    const events=[];
    for(const line of raw.split('\n').filter(Boolean)) { try {events.push(JSON.parse(line));} catch {break;} }
    if(events.at(-1)?.event==='finished' && !events.at(-1).needsReview) continue;
    const start=events[0];
    if(start?.event!=='start' || !Array.isArray(start.moves))throw new Error('Unfinished execution record is unreadable. Inspect '+directory);
    const report={record:name,completed:[],notMoved:[],needsReview:[]};
    for(const move of start.moves) {
      if(!safeRelative(move.relativePath)||!safeRelative(move.targetRelativePath)||!move.targetRelativePath.startsWith(OUTPUT+'/'))throw new Error('Invalid path in execution record');
      const sourceRoot=start.sourceRoot;
      if(path.resolve(sourceRoot)!==path.resolve(root) && path.resolve(sourceRoot)!==path.join(path.resolve(root),'Inbox'))throw new Error('Invalid source in execution record');
      const from=inside(sourceRoot,move.relativePath),to=inside(root,move.targetRelativePath);
      async function state(file) {
        try {await directoryIdentity(path.dirname(file)); const s=await statOrNull(file); if(!s)return 'absent'; if(!s.isFile()||s.isSymbolicLink())return 'changed'; return equal(identity(s),move.identity) && await hashFile(file,s)===move.hash ? 'match':'changed';}catch{return 'changed';}
      }
      const [a,b]=await Promise.all([state(from),state(to)]);
      (a==='absent'&&b==='match'?report.completed:a==='match'&&b==='absent'?report.notMoved:report.needsReview).push({relativePath:move.relativePath,targetRelativePath:move.targetRelativePath});
    }
    reports.push(report);
  }
  return reports;
}
function outputSnapshot(output) {const {recoveries,...snapshot}=output;return snapshot;}
function ensureRecovered(output) { if(output.recoveries.some(r=>r.needsReview.length))throw new Error('An interrupted move needs review. Inspect both file locations in the recovery report before creating another plan.'); }
export const planSchema = {
  type:'object',additionalProperties:false,required:['summary','moves'],properties:{summary:{type:'string'},moves:{type:'array',items:{
    type:'object',additionalProperties:false,required:['relativePath','category','action','assessment','reason'],properties:{
      relativePath:{type:'string'},category:{type:'string'},action:{type:'string',enum:['move','keep','review']},assessment:{type:'string',enum:['reuse','reclassify','uncertain']},reason:{type:'string'}
    }
  }}}
};
export function validatePlan(plan,files) {
  if(!plan || typeof plan.summary!=='string'||!Array.isArray(plan.moves)||plan.moves.length!==files.length)throw new Error('Codex returned an incomplete plan. Please try again');
  const names=new Set(files.map(fileKey));
  for(const m of plan.moves) {
    if(!m || !safeRelative(m.relativePath)||!names.delete(m.relativePath)||!['move','keep','review'].includes(m.action)||!['reuse','reclassify','uncertain'].includes(m.assessment)||typeof m.reason!=='string'||typeof m.category!=='string'||(m.action==='move'&&!safeCategory(m.category))||(m.category&&!safeCategory(m.category)))throw new Error('The plan contains duplicate files, unknown files or invalid folders');
  }
  return plan;
}
// Preserve these compound extensions as a unit; other names use the last suffix.
export function splitExtension(name) {
  const compound=name.match(/\.(?:tar\.(?:gz|bz2|xz|zst)|user\.js)$/i);
  const ext=compound?.[0] || path.extname(name);
  return [name.slice(0,name.length-ext.length),ext];
}
export async function allocatePlan(root,plan,files) {
  validatePlan(plan,files);
  const output=await inspectOutput(root); ensureRecovered(output);
  const canonical=new Map(output.folders.map(f=>[folded(f.name),f.name]));
  const moves=plan.moves.map(m=>({...m,name:files.find(f=>fileKey(f)===m.relativePath).name})).sort((a,b)=>sort(a.relativePath,b.relativePath));
  for(const m of moves) {if(m.category){const key=folded(m.category);if(!canonical.has(key))canonical.set(key,m.category);m.category=canonical.get(key);}}
  const occupied=new Set(output.targets.map(t=>folded(t.category+'/'+t.name)));
  const reserved=new Set(),counts=new Map();
  for(const m of moves.filter(m=>m.action==='move')) { const name=m.requestedName || m.name, key=folded(m.category+'/'+name);reserved.add(key);counts.set(key,(counts.get(key)||0)+1); }
  for(const m of moves) {
    m.targetName=null;m.targetRelativePath=null;m.blocker=null;m.renameReason=null;m.renamed=false;
    if(m.action!=='move')continue;
    let name=m.requestedName || m.name;
    const key=folded(m.category+'/'+name);
    if(m.requestedName && (!safeCategory(name)||occupied.has(key)||counts.get(key)>1)) {m.blocker='Choose a valid, unused target name or exclude this file.';continue;}
    if(!m.requestedName && (occupied.has(key)||counts.get(key)>1)) {
      const [base,ext]=splitExtension(name); let n=1;
      while(occupied.has(folded(m.category+'/'+base+' '+n+ext))||reserved.has(folded(m.category+'/'+base+' '+n+ext))) n++;
      name=base+' '+n+ext; m.renameReason='Numbered to avoid a name conflict.';
    }
    m.targetName=name; m.targetRelativePath=OUTPUT+'/'+m.category+'/'+name;m.renamed=name!==m.name;
    if(m.renamed && !m.renameReason)m.renameReason='Target name chosen by you.';
    if(!safeCategory(name)||inside(root,m.targetRelativePath).length>240)m.blocker='Target name or path is too long or unsupported. Edit the target name/category or exclude this file.';
    occupied.add(folded(m.category+'/'+name));
  }
  return {summary:plan.summary,moves,outputSnapshot:outputSnapshot(output),revision:randomUUID(),counts:{move:moves.filter(m=>m.action==='move').length,renamed:moves.filter(m=>m.renamed).length,keep:moves.filter(m=>m.action==='keep').length,review:moves.filter(m=>m.action==='review').length,blocked:moves.filter(m=>m.blocker).length}};
}
async function createOutput(root,expected) {
  const before=await inspectOutput(root);
  if(!equal(outputSnapshot(before),expected))throw new Error('Destination changed. Refresh the plan and review the new names.');
  const out=path.join(root,OUTPUT);
  if(!before.exists){await mkdir(out);await writeFile(path.join(out,MARKER),JSON.stringify({app:'personal-ai-organizer',version:1,root:await directoryIdentity(root),output:await directoryIdentity(out)}),{flag:'wx'});}
  return out;
}
export async function executePlan(root,plan,original,source=null) {
  const sourceRoot=source?.root || path.join(root,'Inbox');
  const receipt={completed:[],notMoved:plan.moves.filter(m=>m.action==='move'),needsReview:[],kept:plan.moves.filter(m=>m.action==='keep')};
  let journal;
  const rootIdentity=await directoryIdentity(root);
  const record=async event=>{if(journal){await journal.write(JSON.stringify(event)+'\n');await journal.sync();}};
  try {
    validatePlan(plan,original);
    if(plan.moves.some(m=>m.action==='review'||m.blocker))throw new Error('Resolve review items and blocked destinations before approving.');
    if(!plan.revision)throw new Error('Review a prepared plan before approving.');
    const fresh=await scanFolder(sourceRoot,{firstLevelOnly:source?.firstLevelOnly??true});
    if(source && (!equal(fresh.rootIdentity,source.rootIdentity)||!equal(fresh.directories,source.directories)))throw new Error('Files have changed. Rescan the folder and make a new plan.');
    const current=await prepareInventory(fresh);
    if(!equal(current,original))throw new Error('Files have changed. Rescan the folder and make a new plan.');
    const regenerated=await allocatePlan(root,plan,original);
    if(!equal(regenerated.moves,plan.moves)||!equal(regenerated.outputSnapshot,plan.outputSnapshot))throw new Error('Destination changed. Refresh the plan and approve the new names.');
    if(!receipt.notMoved.length)return [];
    const out=await createOutput(root,plan.outputSnapshot),outputIdentity=await directoryIdentity(out);
    const folderIds=new Map();
    for(const category of new Set(receipt.notMoved.map(m=>m.category))){const dir=path.join(out,category);if(!await statOrNull(dir))await mkdir(dir);folderIds.set(category,await directoryIdentity(dir));}
    const records=path.join(out,RECORDS);if(!await statOrNull(records))await mkdir(records);await directoryIdentity(records);
    journal=await open(path.join(records,randomUUID()+'.jsonl'),'wx');
    const journalMoves=receipt.notMoved.map(m=>{const f=original.find(f=>fileKey(f)===m.relativePath);return {...m,identity:identity(f),hash:f.hash};});
    await record({event:'start',time:new Date().toISOString(),sourceRoot,moves:journalMoves});
    async function checkParents(move) {
      if(!equal(await directoryIdentity(root),rootIdentity))throw new Error('Destination root changed');
      for(const d of fresh.directories) {if(d.relativePath==='' || move.relativePath.startsWith(d.relativePath+'/')) {if(!equal(await directoryIdentity(d.relativePath?inside(sourceRoot,d.relativePath):sourceRoot),d.identity))throw new Error('Source folder changed');}}
      if(!equal(await directoryIdentity(out),outputIdentity)||!equal(await directoryIdentity(path.join(out,move.category)),folderIds.get(move.category)))throw new Error('Destination folder changed');
    }
    for(const move of plan.moves.filter(m=>m.action==='move')) {
      await checkParents(move);
      const file=original.find(f=>fileKey(f)===move.relativePath),from=inside(sourceRoot,move.relativePath),to=inside(root,move.targetRelativePath);
      if(await statOrNull(to))throw new Error('Destination already exists. Refresh the plan. Nothing will be overwritten.');
      if(await hashFile(from,file)!==file.hash)throw new Error('Files have changed. Rescan the folder and make a new plan.');
      await record({event:'moving',relativePath:move.relativePath});
      await link(from,to);receipt.needsReview.push(move);
      await checkParents(move);
      const linked=await lstat(from),target=await lstat(to);
      if(!equal(identity(linked),identity(file))||!equal(identity(target),identity(file))||target.isSymbolicLink()||await hashFile(from,linked)!==file.hash)throw new Error('Files changed while moving. Inspect both locations.');
      await checkParents(move);
      if(!equal(metadata(await lstat(from)),metadata(linked)))throw new Error('Files changed while moving. Inspect both locations.');
      await unlink(from);receipt.needsReview.pop();receipt.completed.push(move);receipt.notMoved=receipt.notMoved.filter(m=>m!==move);
      await record({event:'completed',relativePath:move.relativePath});
    }
    await record({event:'finished',status:'completed',needsReview:false});
    return receipt.completed;
  }catch(e){receipt.notMoved=plan.moves.filter(m=>m.action==='move'&&!receipt.completed.includes(m)&&!receipt.needsReview.includes(m));e.receipt=receipt;try{await record({event:'finished',status:'failed',needsReview:!!receipt.needsReview.length,receipt});}catch{}throw e;}
  finally{await journal?.close();}
}
