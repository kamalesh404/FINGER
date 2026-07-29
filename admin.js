const tokenInput = document.querySelector('#token');
const loadBtn = document.querySelector('#load');
const statusEl = document.querySelector('#status');
const reportsEl = document.querySelector('#reports');
const recordingsEl = document.querySelector('#recordings');
const tabReports = document.querySelector('#tabReports');
const tabRecordings = document.querySelector('#tabRecordings');

const stored = localStorage.getItem('admin_token');
if (stored) { tokenInput.value = stored; loadAll(); }

tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadAll(); });
loadBtn.addEventListener('click', loadAll);
tabReports.addEventListener('click', () => { tabReports.classList.add('active'); tabRecordings.classList.remove('active'); reportsEl.hidden = false; recordingsEl.hidden = true; });
tabRecordings.addEventListener('click', () => { tabRecordings.classList.add('active'); tabReports.classList.remove('active'); recordingsEl.hidden = false; reportsEl.hidden = true; });

async function loadAll() {
  const token = tokenInput.value.trim();
  if (!token) { statusEl.textContent = 'Enter a token'; return; }
  localStorage.setItem('admin_token', token);
  loadBtn.disabled = true;
  statusEl.textContent = 'Loading...';
  await Promise.all([loadReports(token), loadRecordings(token)]);
  loadBtn.disabled = false;
}

async function loadReports(token) {
  try {
    const resp = await fetch('/api/admin/reports', { headers: { Authorization: 'Bearer ' + token } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    renderReports(data.reports, token);
    statusEl.textContent = data.reports.length + ' report(s) loaded';
  } catch (err) {
    if (!reportsEl.children.length) statusEl.textContent = err.message;
    reportsEl.innerHTML = '<div class="empty-state">' + err.message + '</div>';
  }
}

async function loadRecordings(token) {
  try {
    const resp = await fetch('/api/admin/recordings', { headers: { Authorization: 'Bearer ' + token } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    renderRecordings(data.recordings, token);
  } catch (err) {
    recordingsEl.innerHTML = '<div class="empty-state">' + err.message + '</div>';
  }
}

function renderReports(list, token) {
  reportsEl.innerHTML = '';
  if (!list.length) { reportsEl.innerHTML = '<div class="empty-state">No reports yet</div>'; return; }
  list.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const meta = document.createElement('div');
    meta.className = 'admin-meta';
    const title = document.createElement('strong');
    const hasRecording = r.fingerprint?.recording_id ? ' \uD83D\uDCF9' : '';
    title.textContent = 'Report #' + r.id + hasRecording;
    const date = document.createElement('small');
    date.textContent = new Date(r.created_at).toLocaleString() + '  \u00b7  ' + r.event_count + ' events';
    meta.append(title, date);

    const actions = document.createElement('div');
    actions.className = 'admin-actions';

    const viewBtn = document.createElement('button');
    viewBtn.className = 'text-button';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => viewReport(r));

    const dlBtn = document.createElement('button');
    dlBtn.className = 'text-button';
    dlBtn.textContent = 'Download';
    dlBtn.addEventListener('click', () => downloadReport(r.id, token));

    actions.append(viewBtn, dlBtn);
    row.append(meta, actions);
    reportsEl.append(row);
  });
}

function renderRecordings(list, token) {
  recordingsEl.innerHTML = '';
  if (!list.length) { recordingsEl.innerHTML = '<div class="empty-state">No recordings yet</div>'; return; }
  list.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const meta = document.createElement('div');
    meta.className = 'admin-meta';
    const title = document.createElement('strong');
    title.textContent = 'Recording #' + r.id;
    const date = document.createElement('small');
    const size = r.bytes ? (r.bytes / 1024).toFixed(1) + ' KB' : 'unknown size';
    date.textContent = new Date(r.created_at).toLocaleString() + '  \u00b7  ' + size + '  \u00b7  ' + (r.mime_type || 'webm');
    meta.append(title, date);

    const actions = document.createElement('div');
    actions.className = 'admin-actions';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'text-button';
    dlBtn.textContent = 'Download';
    dlBtn.addEventListener('click', () => downloadRecording(r.id, token));

    actions.append(dlBtn);
    row.append(meta, actions);
    recordingsEl.append(row);
  });
}

async function downloadReport(id, token) {
  try {
    const resp = await fetch('/api/admin/reports/' + id + '/download', { headers: { Authorization: 'Bearer ' + token } });
    if (!resp.ok) { statusEl.textContent = 'Download failed'; return; }
    const blob = await resp.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'report-' + id + '.json';
    link.click();
    URL.revokeObjectURL(link.href);
    statusEl.textContent = 'Report #' + id + ' downloaded';
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

async function downloadRecording(id, token) {
  try {
    const resp = await fetch('/api/admin/recordings/' + id, { headers: { Authorization: 'Bearer ' + token } });
    if (!resp.ok) { statusEl.textContent = 'Download failed'; return; }
    const blob = await resp.blob();
    const ext = blob.type.includes('webm') ? 'webm' : 'mp4';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'recording-' + id + '.' + ext;
    link.click();
    URL.revokeObjectURL(link.href);
    statusEl.textContent = 'Recording #' + id + ' downloaded';
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

function viewReport(r) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const panel = document.createElement('div');
  panel.className = 'overlay-panel';
  const head = document.createElement('div');
  head.className = 'overlay-head';
  head.innerHTML = '<strong>Report #' + r.id + '</strong><button class="text-button close-btn">Close</button>';
  head.querySelector('.close-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const body = document.createElement('div');
  body.className = 'overlay-body';
  const pre = document.createElement('pre');
  pre.className = 'json-view';
  pre.textContent = JSON.stringify(r.fingerprint, null, 2);
  body.append(pre);
  panel.append(head, body);
  overlay.append(panel);
  document.body.append(overlay);
}
