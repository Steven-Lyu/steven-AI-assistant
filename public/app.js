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
const labels = { submitted:'Getting ready', running:'Thinking', waiting_approval:'Permission needed', waiting_confirmation:'Ready to review', executing:'Organizing', completed:'Completed', failed:'Needs attention', cancelled:'Cancelled', cancelling:'Cancelling', updating_plan:'Updating preview' };
const terminal = ['completed','failed','cancelled'];
let token, tasks = [], selected, submitting = false, actionPending = false, connected = false, lastKey = '', lastTaskState = '', historyLimit = 5;
let organizeTaskId = null, planDirty = false;
let sourceMode = 'folder', folder = null, folderPending = false, folderStale = false;
const staleTasks = new Set();
const animatedCompletions = new Set();
function transferScene(task, animate = false) {
  const done = task.status === 'completed';
  const groups = new Map();
  for (const move of task.plan.moves.filter(m=>m.action==='move')) {
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
  $('#start').disabled = submitting || folderPending || !connected || !token || active || (sourceMode === 'folder' && (!folder?.files.length || !folder.complete || folder.recoveries?.some(r=>r.needsReview.length) || folderStale || folder.firstLevelOnly!==$('#first-level-only').checked));
  for (const id of ['browse','rescan','use-sample']) $(`#${id}`).disabled = submitting || folderPending || active || !connected || !token;
  $('#first-level-only').disabled=submitting||folderPending||active||!connected;
  $('#cancel-scan').hidden=!folderPending;$('#cancel-scan').disabled=!connected||!folderPending;
  $('#scan-progress').hidden=!folderPending;
  $('#browse').textContent = folderPending ? 'Selecting…' : 'Browse';
  $('#browse').setAttribute('aria-busy', String(folderPending));
  $('#start').setAttribute('aria-busy', String(submitting));
  const current = tasks.find(t=>t.id===selected) || tasks[0];
  const cancelButton=$('#cancel-task');
  cancelButton.hidden=!current || terminal.includes(current.status) || ['executing','cancelling'].includes(current.status);
  if(cancelButton.hidden && document.activeElement===cancelButton){$('#task-heading').tabIndex=-1;$('#task-heading').focus({preventScroll:true});}
  document.querySelectorAll('[data-action], [data-approval]').forEach(b => b.disabled = !connected || actionPending || b.dataset.answered === 'true');
  const confirm=$('#confirm-task');if(confirm)confirm.disabled ||= planDirty || current?.plan?.counts.review>0 || current?.plan?.counts.blocked>0;
  document.querySelectorAll('.plan-editor input').forEach(el=>el.disabled=!connected||actionPending);
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
  $('#source-summary').textContent = sample ? `${$('#first-level-only').checked?'6 files':'8 files, including 2 nested examples'} · A fresh set for every task` : folder ? `${folder.files.length} files · ${formatSize(folder.files.reduce((total,f)=>total+f.size,0))} · ${folder.skipped.length} skipped` : `${$('#first-level-only').checked?'First-level files':'Including subfolders'} · Up to 200 files`;
  $('#source-path').hidden = sample || !folder; $('#source-path').textContent = folder?.root || '';
  $('#rescan').hidden = sample || !folder;
  $('#use-sample').hidden = sample;
  $('#source-status').textContent = folderPending ? 'Choose a folder in the Windows window. Scanning follows your selection.' : sample ? 'Sample files stay separate from your folders.' : folderStale ? 'Folder contents may have changed. Rescan before making another plan.' : folder ? folder.files.length ? `${folder.firstLevelOnly?'First-level files only.':'Including subfolders.'} Output: Organized/category. ${folder.complete?'':'Scan incomplete — choose a smaller accessible folder.'}` : 'No files need organizing in this scope.' : 'Choose a folder to preview its files.';
  $('#source-preview').hidden = sample || !folder;
  $('#preview-summary').textContent = `Preview ${folder?.files.length || 0} files · ${folder?.skipped.length || 0} skipped`;
  $('#source-files').innerHTML = folder ? folder.files.map(f=>`<div class="inventory-row">${icon('file')}<span>${escape(f.relativePath || f.name)}</span><small>${formatSize(f.size)}</small></div>`).join('') + folder.skipped.map(f=>`<div class="inventory-row skipped">${icon('folder')}<span>${escape(f.relativePath || f.name)}</span><small>${escape(f.reason)}</small></div>`).join('') : '';
  if(folder){$('#source-files').innerHTML += (folder.unscanned||[]).map(f=>`<div class="inventory-row skipped"><span>${escape(f.relativePath)}</span><small>Not scanned: ${escape(f.reason)}</small></div>`).join('') + (folder.recoveries||[]).map(r=>`<details class="details" open><summary>Recovered execution: ${r.completed.length} moved · ${r.notMoved.length} not moved · ${r.needsReview.length} need checking</summary>${[['Moved',r.completed],['Not moved',r.notMoved],['Check both locations',r.needsReview]].map(([label,items])=>items.map(m=>`<p class="path">${label}: ${escape(m.relativePath)} → ${escape(m.targetRelativePath)}</p>`).join('')).join('')}</details>`).join('');}
  if(folder&&!folder.complete)$('#source-status').textContent='Scan incomplete. Review unscanned locations below, then choose a smaller accessible folder.';
  if(folder?.recoveries?.some(r=>r.needsReview.length))$('#source-status').textContent='An interrupted move needs review. Check the recovery report below before planning.';
  $('#input-help').textContent = sample ? 'Only generated sample files are used.' : 'Paths, names and sizes go to Codex. Contents stay local.';
  updateControls();
}
async function selectFolder(rescan = false) {
  if (folderPending) return;
  if(rescan)folderStale=true;
  folderPending = true; $('#source-error').hidden = true; renderSource();
  try {
    const result = await api(rescan ? '/api/folders/rescan' : '/api/folders/browse', { ...(rescan ? { selectionId: folder.id } : {}), firstLevelOnly:$('#first-level-only').checked }, 135000);
    if (result.cancelled && rescan) folder=null;
    if (!result.cancelled) { folder=result; sourceMode='folder'; folderStale=false; }
  } catch(e) { $('#source-error').textContent=e.message; $('#source-error').hidden=false; if(rescan){folderStale=true;folder=null;} }
  finally { folderPending=false; renderSource(); $('#browse').focus({preventScroll:true}); }
}
$('#first-level-only').addEventListener('change',()=>{if(folder && sourceMode==='folder')selectFolder(true);else renderSource();});
$('#cancel-scan').addEventListener('click',async()=>{try{await api('/api/folders/cancel');}catch(e){$('#source-error').textContent=e.message;$('#source-error').hidden=false;}});
setInterval(async()=>{if(!folderPending)return;try{const response=await fetch('/api/folders/progress');const data=await response.json();if(folderPending)$('#scan-progress').textContent=data.progress?.phase==='scanning'?`Scanning: ${data.progress.files||0} files · ${data.progress.directories||0} folders`:'Waiting for folder selection…';}catch{}},700);
$('#browse').addEventListener('click',()=>selectFolder());
$('#rescan').addEventListener('click',()=>selectFolder(true));
$('#use-sample').addEventListener('click',()=>{sourceMode='sample';$('#source-error').hidden=true;renderSource();$('#instruction').focus();});
function render() {
  const activeScope=tasks.find(t=>!terminal.includes(t.status));
  if(activeScope && $('#first-level-only').checked!==activeScope.firstLevelOnly){$('#first-level-only').checked=activeScope.firstLevelOnly;renderSource();}
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
  const key = JSON.stringify([task.id,task.status,task.plan,task.result,task.approvals,task.events,task.error,task.phase,task.progress,connected]);
  if (key === lastKey) { updateControls(); return; }
  lastKey = key;
  const openDetails = new Set([...document.querySelectorAll('#task-content details[open]')].map(d => d.id));
  const focused = document.activeElement?.id;
  const stateChanged = lastTaskState !== `${task.id}:${task.status}`;
  lastTaskState = `${task.id}:${task.status}`;
  let content = `<div class="task-title"><strong>${escape(task.title)}</strong><small>${task.firstLevelOnly?'First level':'Including subfolders'} · ${time(task.createdAt)}</small></div><ol class="steps" aria-label="Task progress">${['Submitted','Planning','Review','Organized'].map((label,i) => {
    const step = task.status === 'completed' ? 4 : task.plan ? 2 : ['running','waiting_approval'].includes(task.status) ? 1 : 0;
    return `<li class="${i<step?'done':i===step&&!terminal.includes(task.status)?'current':''}" ${i===step?'aria-current="step"':''}>${label}</li>`;
  }).join('')}</ol>`;
  if (['submitted','running','cancelling'].includes(task.status)) {
    const stages = { checking: 'Checking your files…', connecting: 'Connecting to Codex…', starting: 'Starting the assistant…', planning: 'Finding a place for each file…', destinations: 'Preparing final destinations…', retrying: 'Reconnecting to the model…' };
    const stage = !connected ? 'Waiting for the local service…' : task.status==='cancelling' ? 'Cancelling your task…' : stages[task.phase] || 'Preparing your task…';
    const detail = !connected ? 'Task status is unavailable until the connection returns.' : task.status==='cancelling' ? 'Stopping the assistant. No organizing plan will be applied.' : task.phase==='checking' ? `${task.progress?.completed || 0} of ${task.progress?.total || task.files.length} files checked locally.` : task.phase==='retrying' ? task.notice : 'You can cancel while the assistant is working.';
    content += `<div class="activity">${connected?'<span class="spinner" aria-hidden="true"></span>':''}<div><strong>${escape(stage)}</strong><p>${escape(detail)}</p><small class="task-elapsed" data-started="${escape(task.createdAt)}"></small></div></div>`;
    if(connected && task.phase==='planning' && task.status==='running') content += `<div class="running-files" aria-hidden="true"><span>${icon('file')}</span><span>${icon('file')}</span><span>${icon('file')}</span></div>`;
  }
  for (const a of task.approvals) {
    const p = a.params;
    content += `<section class="approval" aria-labelledby="approval-title-${escape(a.id)}"><p class="eyebrow">CODEX PERMISSION</p><h3 id="approval-title-${escape(a.id)}">${a.method.includes('commandExecution')?'Run a command?':a.method.includes('fileChange')?'Allow file changes?':'Allow additional access?'}</h3><p>${escape(p.reason || 'Review this operation before granting permission.')}</p><p class="scope"><strong>Scope:</strong> ${escape(p.cwd || p.grantRoot || task.root)} · This request only</p><pre>${escape(JSON.stringify({command:p.command || a.item?.command,changes:a.item?.changes,permissions:p.permissions,additionalPermissions:p.additionalPermissions,network:p.networkApprovalContext,grantRoot:p.grantRoot},null,2))}</pre><p>File organizing still needs your separate approval.</p><div class="actions"><button id="deny-${escape(a.id)}" class="button secondary" data-approval="${escape(a.id)}" data-allow="false" data-answered="${a.answered}">Decline</button><button id="allow-${escape(a.id)}" class="button primary" data-approval="${escape(a.id)}" data-allow="true" data-answered="${a.answered}">${a.answered?'Decision sent':'Allow once'}</button></div></section>`;
  }
  if (task.plan) {
    const transferred = ['executing','completed'].includes(task.status);
    const animateTransfer = stateChanged && task.status === 'completed' && organizeTaskId === task.id && !animatedCompletions.has(task.id);
    if (animateTransfer) animatedCompletions.add(task.id);
    if (transferred && task.plan.counts.move) content += transferScene(task, animateTransfer);
    if (transferred) content += '<details id="moved-file-details" class="details"><summary>View files & destinations</summary>';
    if(stateChanged)planDirty=false;
    content += reviewPlan(task);
    if (transferred) content += '</details>';
    if (task.status === 'waiting_confirmation') content += `<div class="business-confirm"><strong>${task.plan.counts.move ? `Move ${task.plan.counts.move} files to these folders?` : 'No files selected to move.'}</strong><p>${task.plan.counts.renamed} renamed · Contents stay the same.</p><p class="path">${escape(task.root)}/Organized</p><p id="plan-edit-status" role="status">${task.plan.counts.review||task.plan.counts.blocked?'Resolve or exclude items needing review before approval.':'Review the final paths before approving.'}</p><button class="button secondary" data-action="revise">Update preview</button><button id="confirm-task" class="button primary" data-action="confirm">${task.plan.counts.move?'Approve & organize':'Finish without moving'} ${icon('arrow')}</button></div>`;
  }
  if (task.receipt) content += `<section class="move-receipt"><h3>Move report</h3><p>${task.receipt.completed.length} moved · ${task.receipt.notMoved.length} not moved · ${task.receipt.needsReview.length} need checking</p>${[['Moved',task.receipt.completed],['Not moved',task.receipt.notMoved],['Check both locations',task.receipt.needsReview]].map(([label,items])=>items.length?`<details class="details" open><summary>${label}</summary><ul>${items.map(m=>`<li>${escape(m.relativePath)} → ${escape(m.targetRelativePath)}</li>`).join('')}</ul></details>`:'').join('')}</section>`;
  if (task.status==='failed') {
    const limited = /usage limit|quota|rate limit/i.test(task.error || '');
    content += `<div class="error"><h3>${limited?'Usage limit reached.':'This task needs another try.'}</h3><p>${escape(task.error)}</p><p>${limited?'Try again when your Codex usage is available.':task.receipt?'Review the move report, then rescan the folder. Completed moves have been kept.':'Rescan your folder or choose it again, then make a new plan.'}</p><button class="button secondary" data-retry>${task.sourceMode==='folder'?'Choose files':'Try again'}</button></div>`;
  }
  if (task.status==='cancelled') content += '<div class="activity">Task cancelled. No organizing plan was applied.</div>';
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
  try { const t=await api('/api/tasks',{instruction:$('#instruction').value,sourceMode,firstLevelOnly:$('#first-level-only').checked,selectionId:sourceMode==='folder'?folder?.id:undefined}); selected=t.id; tasks=[t,...tasks.filter(item=>item.id!==t.id)]; render(); }
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
    const actionTaskId=selected;
    if(b.dataset.action==='cancel'){b.textContent='Cancelling…';b.setAttribute('aria-busy','true');}
    if(b.dataset.action==='confirm') organizeTaskId=actionTaskId;
    try{
      if(b.dataset.approval){const a=tasks.find(t=>t.id===selected)?.approvals.find(a=>String(a.id)===b.dataset.approval);if(!a)throw new Error('This permission request has expired.');await api(`/api/tasks/${selected}/approval`,{requestId:a.id,allow:b.dataset.allow==='true'});}
      else { const task=tasks.find(t=>t.id===actionTaskId);const payload={revision:task.plan?.revision};if(b.dataset.action==='revise')payload.changes=collectPlanEdits();const response=await api(`/api/tasks/${actionTaskId}/${b.dataset.action}`,payload);planDirty=false; if(response.task){ tasks=tasks.map(t=>t.id===response.task.id?response.task:t); render(); } }
    }catch(e){$('#action-error').textContent=e.message;$('#action-error').hidden=false;}
    finally{actionPending=false;updateControls();const cancel=$('#cancel-task');if(cancel){cancel.textContent='Cancel task';cancel.removeAttribute('aria-busy');}}
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
events.onerror=()=>{connected=false;$('#connection').textContent='Reconnecting';$('#connection').classList.remove('online');$('#connection-error').hidden=false;render();};

setInterval(()=>{document.querySelectorAll('[data-started]').forEach(el=>{const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(el.dataset.started))/1000));el.textContent=`Elapsed ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;});},1000);

function reviewPlan(task) {
  const editable=task.status==='waiting_confirmation',groups=new Map();
  task.plan.moves.forEach((m,i)=>{const key=m.action==='keep'?'Keep in place':m.category||'Needs a category';if(!groups.has(key))groups.set(key,[]);groups.get(key).push({m,i});});
  const counts=task.plan.counts;
  return `<div class="plan-heading"><h3>${task.status==='completed'?(task.result?.length?'Files organized.':'No files moved.'):'Review your destinations.'}</h3></div><p class="plan-counts">${counts.move} to move · ${counts.renamed} renamed · ${counts.keep} kept · ${counts.review} to review · ${task.skipped?.length||0} skipped</p><div class="file-list plan-list">${[...groups].map(([category,items])=>`<section class="plan-group"><h4>${escape(category)}</h4>${items.map(({m,i})=>`<article class="plan-item ${editable?'plan-editor':''}" data-move-index="${i}"><strong>${escape(m.relativePath)}</strong><p class="path">${m.action==='move'?`→ ${escape(task.root)}/${escape(m.targetRelativePath||'Destination needs attention')}`:m.action==='keep'?'Stays in its current folder':'Needs your decision'}</p><p>${escape(m.reason)} <span class="assessment">${{reuse:'Existing category fits',reclassify:'Reclassified',uncertain:'Uncertain'}[m.assessment]}</span></p>${m.renamed?`<p class="rename-note">${escape(m.name)} → ${escape(m.targetName)} · ${escape(m.renameReason)}</p>`:''}${m.blocker?`<p class="inline-error" role="alert">${escape(m.blocker)}</p>`:''}${editable?`<fieldset><legend>Action for ${escape(m.relativePath)}</legend>${['move','keep','review'].map(a=>`<label><input type="radio" name="action-${i}" value="${a}" ${m.action===a?'checked':''}>${{move:'Move',keep:'Keep',review:'Review'}[a]}</label>`).join('')}</fieldset><div class="plan-fields"><label for="category-${i}">Category<input id="category-${i}" data-category value="${escape(m.category)}" maxlength="255"></label><label for="target-${i}">Target name (optional)<input id="target-${i}" data-target-name value="${escape(m.requestedName||'')}" placeholder="Automatic" maxlength="255"></label></div>`:''}</article>`).join('')}</section>`).join('')}</div>${task.skipped?.length?`<details class="details"><summary>${task.skipped.length} skipped items</summary>${task.skipped.map(f=>`<p>${escape(f.relativePath||f.name)} — ${escape(f.reason)}</p>`).join('')}</details>`:''}`;
}
function collectPlanEdits(){const task=tasks.find(t=>t.id===selected);return [...document.querySelectorAll('.plan-editor')].map(el=>({relativePath:task.plan.moves[Number(el.dataset.moveIndex)].relativePath,action:el.querySelector('input[type=radio]:checked').value,category:el.querySelector('[data-category]').value.trim(),requestedName:el.querySelector('[data-target-name]').value}));}
document.addEventListener('input',e=>{if(e.target.closest('.plan-editor')){planDirty=true;const status=$('#plan-edit-status');if(status)status.textContent='Changes not applied. Update preview to recalculate destinations.';updateControls();}});
