const tokenInput = document.querySelector('#token');
const loadBtn = document.querySelector('#load');
const statusEl = document.querySelector('#status');
const reportsEl = document.querySelector('#reports');

const stored = localStorage.getItem('admin_token');
if (stored) { tokenInput.value = stored; loadReports(); }

tokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadReports(); });
loadBtn.addEventListener('click', loadReports);

async function loadReports() {
  const token = tokenInput.value.trim();
  if (!token) { statusEl.textContent = 'Enter a token'; return; }
  localStorage.setItem('admin_token', token);
  loadBtn.disabled = true;
  statusEl.textContent = 'Loading...';
  try {
    const resp = await fetch('/api/admin/reports', { headers: { Authorization: 'Bearer ' + token } });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed');
    renderReports(data.reports, token);
    statusEl.textContent = data.reports.length + ' report(s) loaded';
  } catch (err) {
    statusEl.textContent = err.message;
    reportsEl.innerHTML = '';
  } finally {
    loadBtn.disabled = false;
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
    title.textContent = 'Report #' + r.id;
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
