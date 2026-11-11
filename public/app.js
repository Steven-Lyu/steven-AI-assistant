const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const paths = {
  folder:'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11H3Z',
  file:'M6 3h8l4 4v14H6Z M14 3v5h4 M9 12h6 M9 16h6',
  grid:'M3 3h7v7H3Z M14 3h7v7h-7Z M3 14h7v7H3Z M14 14h7v7h-7Z',
  calendar:'M4 5h16v16H4Z M4 10h16 M8 3v4 M16 3v4 M8 14h2 M14 14h2 M8 17h2',
  mail:'M3 5h18v14H3Z M3 6l9 7 9-7',
  arrow:'M4 12h15 M13 6l6 6-6 6',
  check:'M5 12l4 4L19 6',
  shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z M8 12l3 3 5-6',
  lock:'M5 10h14v11H5Z M8 10V7a4 4 0 0 1 8 0v3 M12 14v3',
  spark:'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3Z',
  clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
document.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon));
const labels = { submitted:'Getting ready', running:'Thinking', waiting_approval:'Permission needed', waiting_confirmation:'Ready to review', executing:'Organizing', completed:'Completed', failed:'Needs attention', cancelled:'Cancelled' };
const terminal = ['completed','failed','cancelled'];
let token, tasks = [], selected, submitting = false, actionPending = false, connected = false, lastKey = '', lastTaskState = '', historyLimit = 5;
let organizeTaskId = null;
let sourceMode = 'folder', folder = null, folderPending = false, folderStale = false;
const staleTasks = new Set();
const animatedCompletions = new Set();
function transferScene(task, animate = false) {
  const done = task.status === 'completed';
  const groups = new Map();
  for (const move of task.plan.moves) {
    if (!groups.has(move.category)) groups.set(move.category, []);
    groups.get(move.category).push(move);
  }
  return `<section class="transfer-scene ${done ? 'transfer-complete' : 'transfer-pending'} ${animate ? 'transfer-play' : ''}" aria-label="${done ? 'Organized files by folder' : 'Organizing approved files'}">
    <div class="transfer-heading"><span>${icon(done ? 'check' : 'folder')}<strong>${done ? `${task.result.length} files organized` : 'Organizing your files…'}</strong></span><small>${done ? 'All moves confirmed' : 'Waiting for file operations'}</small></div>
    ${[...groups].map(([category, moves], index) => `<div class="transfer-lane lane-${index}"><div class="transfer-source"><span class="source-icon">${icon('file')}</span><span>${moves.length} ${moves.length === 1 ? 'file' : 'files'}</span></div><div class="transfer-track" aria-hidden="true"><span class="track-line"></span><span class="flight-card">${icon('file')}</span><span class="flight-card flight-second">${icon('file')}</span></div><div class="transfer-folder"><span class="folder-drawing" aria-hidden="true">${icon('folder')}<i>${icon('check')}</i></span><span><strong>${escape(category)}</strong><small>${done ? 'Organized' : 'Destination'}</small></span></div></div>`).join('')}
  </section>`;
}
const time = value => new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date(value));
const empty = () => `<div class="empty"><div class="file-scene" aria-hidden="true"><span class="paper">${icon('file')}</span><span class="paper">${icon('file')}</span><span class="paper">${icon('file')}</span></div><h3>A fresh start for your files.</h3><p>Make a plan. Review it. Let things fall into place.</p><div class="empty-steps"><span>Plan</span>${icon('arrow')}<span>Review</span>${icon('arrow')}<span>Organize</span></div></div>`;
function updateControls() {
  const active = tasks.some(t => !terminal.includes(t.status));
  $('#start').disabled = submitting || folderPending || !connected || !token || active || (sourceMode === 'folder' && (!folder?.files.length || folderStale));
  for (const id of ['browse','rescan','use-sample']) $(`#${id}`).disabled = submitting || folderPending || active || !connected || !token;
  $('#browse').textContent = folderPending ? 'Selecting…' : 'Browse';
  $('#browse').setAttribute('aria-busy', String(folderPending));
  $('#start').setAttribute('aria-busy', String(submitting));
  document.querySelectorAll('[data-action], [data-approval]').forEach(b => b.disabled = !connected || actionPending || b.dataset.answered === 'true');
}
async function api(route, data = {}, timeout = 65000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(route,{method:'POST',headers:{'Content-Type':'application/json','X-Assistant-Token':token},body:JSON.stringify(data),signal:controller.signal});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
    return result;
  } catch(e) { if (e.name === 'AbortError') throw new Error('No response yet. Check the task status before trying again.'); throw e; }
  finally { clearTimeout(timer); }
}
const formatSize = size => size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : size < 1024 ** 3 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${(size / 1024 ** 3).toFixed(1)} GB`;
function renderSource() {
  const sample = sourceMode === 'sample';
  $('#source-tag').textContent = sample ? 'SAMPLE' : 'LOCAL FILES';
  $('#source-name').textContent = sample ? 'Sample inbox' : folder ? folder.root.split(/[\\/]/).filter(Boolean).at(-1) : 'Choose a folder';
  $('#source-summary').textContent = sample ? '6 files · A fresh set for every task' : folder ? `${folder.files.length} files · ${formatSize(folder.files.reduce((total,f)=>total+f.size,0))} · ${folder.skipped.length} skipped` : 'Files in this folder only · Up to 200 files';
  $('#source-path').hidden = sample || !folder; $('#source-path').textContent = folder?.root || '';
  $('#rescan').hidden = sample || !folder;
  $('#use-sample').hidden = sample;
  $('#source-status').textContent = folderPending ? 'Choose a folder in the Windows window. Scanning follows your selection.' : sample ? 'Sample files stay separate from your folders.' : folderStale ? 'Folder contents may have changed. Rescan before making another plan.' : folder ? folder.files.length ? 'First-level files only. Category folders will be created here.' : 'No eligible files. Choose another folder or rescan.' : 'Choose a folder to preview its files.';
  $('#source-preview').hidden = sample || !folder;
  $('#preview-summary').textContent = `Preview ${folder?.files.length || 0} files · ${folder?.skipped.length || 0} skipped`;
  $('#source-files').innerHTML = folder ? folder.files.map(f=>`<div class="inventory-row">${icon('file')}<span>${escape(f.name)}</span><small>${formatSize(f.size)}</small></div>`).join('') + folder.skipped.map(f=>`<div class="inventory-row skipped">${icon('folder')}<span>${escape(f.name)}</span><small>${escape(f.reason)}</small></div>`).join('') : '';
  $('#input-help').textContent = sample ? 'Only generated sample files are used.' : 'Names and sizes go to Codex. Contents stay local.';
  updateControls();
}
async function selectFolder(rescan = false) {
  if (folderPending) return;
  folderPending = true; $('#source-error').hidden = true; renderSource();
  try {
    const result = await api(rescan ? '/api/folders/rescan' : '/api/folders/browse', rescan ? { selectionId: folder.id } : {}, 135000);
    if (!result.cancelled) { folder=result; sourceMode='folder'; folderStale=false; }
  } catch(e) { $('#source-error').textContent=e.message; $('#source-error').hidden=false; if(rescan)folderStale=true; }
  finally { folderPending=false; renderSource(); $('#browse').focus({preventScroll:true}); }
}
$('#browse').addEventListener('click',()=>selectFolder());
$('#rescan').addEventListener('click',()=>selectFolder(true));
$('#use-sample').addEventListener('click',()=>{sourceMode='sample';$('#source-error').hidden=true;renderSource();$('#instruction').focus();});
function render() {
  for (const t of tasks) if (t.sourceMode==='folder' && terminal.includes(t.status) && !staleTasks.has(t.id)) {
    staleTasks.add(t.id);
    if(folder?.root===t.root) { folderStale=true; renderSource(); }
  }
  const task = tasks.find(t => t.id === selected) || tasks[0];
  $('#count').textContent = tasks.length;
  const history = tasks.slice(0,historyLimit).map(t => `<button class="history-row" data-select="${t.id}" aria-pressed="${t.id === task?.id}">${icon(t.status === 'completed' ? 'check':'folder')}<span>${escape(t.title)}</span><span class="status ${t.status}">${labels[t.status]}</span><time>${time(t.createdAt)}</time></button>`).join('');
  const historyContent = history || '<p class="history-empty">Your next small win will appear here.</p>';
  if ($('#history-list').innerHTML !== historyContent) $('#history-list').innerHTML = historyContent;
  $('#history-more').hidden = tasks.length <= historyLimit;
  if (!task) { $('#task-content').innerHTML = empty(); $('#status').textContent='Ready when you are'; $('#status').className='status'; lastKey=''; lastTaskState=''; updateControls(); return; }
  selected = task.id;
  $('#status').textContent = labels[task.status]; $('#status').className = `status ${task.status}`;
  // Streaming deltas do not rebuild the task UI. Preserve focus, disclosures and animations.
  const key = JSON.stringify([task.id,task.status,task.plan,task.result,task.approvals,task.events,task.error]);
  if (key === lastKey) { updateControls(); return; }
  lastKey = key;
  const openDetails = new Set([...document.querySelectorAll('#task-content details[open]')].map(d => d.id));
  const focused = document.activeElement?.id;
  const stateChanged = lastTaskState !== `${task.id}:${task.status}`;
  lastTaskState = `${task.id}:${task.status}`;
  let content = `<div class="task-title"><strong>${escape(task.title)}</strong><small>${time(task.createdAt)}</small></div><ol class="steps" aria-label="Task progress">${['Submitted','Planning','Review','Organized'].map((label,i) => {
    const step = task.status === 'completed' ? 4 : task.plan ? 2 : ['running','waiting_approval'].includes(task.status) ? 1 : 0;
    return `<li class="${i<step?'done':i===step&&!terminal.includes(task.status)?'current':''}" ${i===step?'aria-current="step"':''}>${label}</li>`;
  }).join('')}</ol>`;
  if (['submitted','running'].includes(task.status)) content += `<div class="activity"><span class="spinner" aria-hidden="true"></span><div><strong>Finding a place for each file…</strong><p>Your assistant is working on the plan.</p></div></div><div class="running-files" aria-hidden="true"><span>${icon('file')}</span><span>${icon('file')}</span><span>${icon('file')}</span></div>`;
  for (const a of task.approvals) {
    const p = a.params;
    content += `<section class="approval" aria-labelledby="approval-title-${escape(a.id)}"><p class="eyebrow">CODEX PERMISSION</p><h3 id="approval-title-${escape(a.id)}">${a.method.includes('commandExecution')?'Run a command?':a.method.includes('fileChange')?'Allow file changes?':'Allow additional access?'}</h3><p>${escape(p.reason || 'Review this operation before granting permission.')}</p><p class="scope"><strong>Scope:</strong> ${escape(p.cwd || p.grantRoot || task.root)} · This request only</p><pre>${escape(JSON.stringify({command:p.command || a.item?.command,changes:a.item?.changes,permissions:p.permissions,additionalPermissions:p.additionalPermissions,network:p.networkApprovalContext,grantRoot:p.grantRoot},null,2))}</pre><p>File organizing still needs your separate approval.</p><div class="actions"><button id="deny-${escape(a.id)}" class="button secondary" data-approval="${escape(a.id)}" data-allow="false" data-answered="${a.answered}">Decline</button><button id="allow-${escape(a.id)}" class="button primary" data-approval="${escape(a.id)}" data-allow="true" data-answered="${a.answered}">${a.answered?'Decision sent':'Allow once'}</button></div></section>`;
  }
  if (task.plan) {
    const transferred = ['executing','completed'].includes(task.status);
    const animateTransfer = stateChanged && task.status === 'completed' && organizeTaskId === task.id && !animatedCompletions.has(task.id);
    if (animateTransfer) animatedCompletions.add(task.id);
    if (transferred) content += transferScene(task, animateTransfer);
    if (transferred) content += '<details id="moved-file-details" class="details"><summary>View files & destinations</summary>';
    content += `<div class="plan-heading"><h3>${task.status==='completed'?'Everything in its place.':'A place for every file.'}</h3><span>${task.plan.moves.length} files</span></div><div class="file-list ${task.status==='completed'&&stateChanged?'settle':''}">${task.plan.moves.map(m => `<div class="file-card"><span class="file-icon">${icon('file')}</span><div><strong>${escape(m.name)}</strong><small>${task.status==='completed'?'Organized':escape(task.sourceRoot || 'Sample inbox')}</small></div><span class="file-destination">${icon(task.status==='completed'?'check':'arrow')}${escape(m.category)}</span></div>`).join('')}</div><details id="reason-details" class="details"><summary>Why these folders?</summary><ul class="reason-list">${task.plan.moves.map(m => `<li><strong>${escape(m.name)}</strong>${escape(m.reason)}</li>`).join('')}</ul></details>`;
    if (transferred) content += '</details>';
    if (task.status === 'waiting_confirmation') content += `<div class="business-confirm"><strong>Move ${task.plan.moves.length} files to these folders?</strong><p>Names and contents stay the same. Destinations are inside:</p><p class="path">${escape(task.root)}</p><button id="confirm-task" class="button primary" data-action="confirm">Approve & organize ${icon('arrow')}</button></div>`;
  }
  if (task.receipt) content += `<section class="move-receipt"><h3>Move report</h3><p>${task.receipt.completed.length} moved · ${task.receipt.notMoved.length} not moved · ${task.receipt.needsReview.length} need checking</p>${[['Moved',task.receipt.completed],['Not moved',task.receipt.notMoved],['Check both locations',task.receipt.needsReview]].map(([label,items])=>items.length?`<details class="details" open><summary>${label}</summary><ul>${items.map(m=>`<li>${escape(m.name)} → ${escape(m.category)}</li>`).join('')}</ul></details>`:'').join('')}</section>`;
  if (task.status==='failed') {
    const limited = /usage limit|quota|rate limit/i.test(task.error || '');
    content += `<div class="error"><h3>${limited?'Usage limit reached.':'This task needs another try.'}</h3><p>${escape(task.error)}</p><p>${limited?'Try again when your Codex usage is available.':task.receipt?'Review the move report, then rescan the folder. Completed moves have been kept.':'Rescan your folder or choose it again, then make a new plan.'}</p><button class="button secondary" data-retry>${task.sourceMode==='folder'?'Choose files':'Try again'}</button></div>`;
  }
  if (task.status==='cancelled') content += '<div class="activity">Task cancelled. No organizing plan was applied.</div>';
  if (!terminal.includes(task.status)&&task.status!=='executing') content += '<button id="cancel-task" class="button ghost" data-action="cancel">Cancel task</button>';
  content += `<details id="activity-details" class="details"><summary>Activity & file location</summary><p class="path">${escape(task.root)}</p><ul>${task.events.map(e => `<li><time>${time(e.time)}</time>${escape(e.message)}</li>`).join('')}</ul></details>`;
  $('#task-content').innerHTML = content;
  if (stateChanged && organizeTaskId === task.id && ['executing','completed'].includes(task.status)) {
    document.querySelector('.transfer-scene')?.scrollIntoView({block:'nearest',behavior:'instant'});
  }
  if (stateChanged) { $('#task-content').classList.remove('enter'); void $('#task-content').offsetWidth; $('#task-content').classList.add('enter'); }
  openDetails.forEach(id => { const el = document.getElementById(id); if (el) el.open = true; });
  if (focused && document.getElementById(focused)) document.getElementById(focused).focus({preventScroll:true});
  else if (focused && ['confirm-task','cancel-task'].includes(focused)) { $('#task-heading').tabIndex=-1; $('#task-heading').focus({preventScroll:true}); }
  updateControls();
}
async function start() {
  if ($('#start').disabled) return;
  $('#form-error').textContent=''; $('#instruction').removeAttribute('aria-invalid');
  if (!$('#instruction').value.trim()) { $('#form-error').textContent='Add an organizing preference to start.'; $('#instruction').setAttribute('aria-invalid','true'); $('#instruction').focus(); return; }
  submitting=true; updateControls();
  try { const t=await api('/api/tasks',{instruction:$('#instruction').value,sourceMode,selectionId:sourceMode==='folder'?folder?.id:undefined}); selected=t.id; tasks=[t,...tasks.filter(item=>item.id!==t.id)]; render(); }
  catch(e) { $('#form-error').textContent=e.message; }
  finally { submitting=false; updateControls(); }
}
$('#task-form').addEventListener('submit',e=>{e.preventDefault();start();});
function route() {
  const page = ['calendar','email'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'files';
  $('#files-page').hidden=page!=='files'; $('#future-page').hidden=page==='files';
  document.querySelectorAll('.nav').forEach(n=>{const active=n.hash===`#${page}`;n.classList.toggle('active',active);if(active)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});
  $('#breadcrumb').textContent={files:'Overview',calendar:'Calendar',email:'Email'}[page];
  document.title=`Personal AI · ${$('#breadcrumb').textContent}`;
  $('#future-title').textContent=page==='calendar'?'A little more time.':'A little less inbox.';
  $('#future-heading').textContent=page==='calendar'?'Calendar assistant':'Email assistant';
  $('#future-description').textContent=page==='calendar'?'Scheduling help is on the horizon.':'Email help is on the horizon.';
  $('#future-icon').innerHTML=icon(page==='calendar'?'calendar':'mail');
}
window.addEventListener('hashchange',route); route();
$('#choose-files').addEventListener('click',()=>$('#instruction').focus());
$('#history-more').addEventListener('click',()=>{historyLimit+=5;render();});
$('#choose-files').disabled=false;
$('#history-more').disabled=false;
document.addEventListener('click',async event=>{
  const b=event.target.closest('button');if(!b||b.disabled)return;
  if(b.dataset.select){selected=b.dataset.select;$('#action-error').hidden=true;render();}
  if('retry' in b.dataset){ if(tasks.find(t=>t.id===selected)?.sourceMode==='folder')return $('#browse').focus(); sourceMode='sample';renderSource();return start(); }
  if(b.dataset.action||b.dataset.approval){
    if(actionPending)return;actionPending=true;updateControls();$('#action-error').hidden=true;
    if(b.dataset.action==='confirm') organizeTaskId=selected;
    try{
      if(b.dataset.approval){const a=tasks.find(t=>t.id===selected)?.approvals.find(a=>String(a.id)===b.dataset.approval);if(!a)throw new Error('This permission request has expired.');await api(`/api/tasks/${selected}/approval`,{requestId:a.id,allow:b.dataset.allow==='true'});}
      else await api(`/api/tasks/${selected}/${b.dataset.action}`);
    }catch(e){$('#action-error').textContent=e.message;$('#action-error').hidden=false;}
    finally{actionPending=false;updateControls();}
  }
});
function autoGrow(){const input=$('#instruction');input.style.height='auto';input.style.height=`${Math.min(input.scrollHeight,320)}px`;$('#char-count').textContent=`${input.value.length} / 2000`;}
$('#instruction').addEventListener('input',autoGrow);autoGrow();
const media=matchMedia('(prefers-reduced-motion: reduce)');
let motionPreference=null;try{motionPreference=localStorage.getItem('reduced-motion');}catch{}
function motion(){const reduce=media.matches||motionPreference==='true';$('#motion').checked=reduce;document.body.classList.toggle('reduced-motion',reduce);}
$('#motion').addEventListener('change',e=>{motionPreference=String(e.target.checked);try{localStorage.setItem('reduced-motion',motionPreference);}catch{}motion();});media.addEventListener('change',motion);motion();
let syncId=0;
async function sync(){const id=++syncId;const res=await fetch('/api/state',{cache:'no-store'});if(!res.ok)throw new Error('Local service unavailable.');const state=await res.json();if(id!==syncId)return;if(token && token!==state.token){folder=null;folderStale=false;renderSource();}token=state.token;tasks=state.tasks;connected=true;$('#connection').textContent='Workspace connected';$('#connection').classList.add('online');$('#connection-error').hidden=true;render();}
renderSource();render();
const events=new EventSource('/api/events');
events.onopen=()=>sync().catch(()=>{connected=false;updateControls();});
events.onmessage=e=>{++syncId;tasks=JSON.parse(e.data);render();if(!connected||!token)sync().catch(()=>{});};
events.onerror=()=>{connected=false;$('#connection').textContent='Reconnecting';$('#connection').classList.remove('online');$('#connection-error').hidden=false;updateControls();};
