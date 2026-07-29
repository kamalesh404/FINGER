const $ = (s) => document.querySelector(s);
const state = { consent: false, mediaStream: null, fingerprint: null, events: [] };
const consent = $('#consent');

consent.addEventListener('change', () => {
  state.consent = consent.checked;
  $('#getAllAccess').disabled = !state.consent;
  if (!state.consent) resetAll();
});

function resetAll() {
  state.fingerprint = null;
  state.events = [];
  $('#signalsCard').hidden = true;
  $('#signals').innerHTML = '';
  $('#profileState').textContent = 'Not collected';
  $('#profileHint').textContent = 'Enable consent and collect your browser profile to see device signals.';
  $('#downloadReport').disabled = true;
}

function addLog(label, detail) {
  state.events.push({ label, detail, at: new Date().toISOString() });
}

function signal(label, value, mono) {
  const el = document.createElement('div');
  el.className = 'signal';
  const l = document.createElement('div');
  l.className = 'signal-label';
  l.textContent = label;
  const v = document.createElement('div');
  v.className = 'signal-value' + (mono ? ' mono' : '');
  v.textContent = value ?? 'Unavailable';
  el.append(l, v);
  return el;
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

function updateBadge(id, text, type) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'pill';
  if (type === 'granted') el.classList.add('green');
  else if (type === 'denied') el.classList.add('red');
  else if (type === 'partial') el.classList.add('amber');
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
  if (stream === state.mediaStream) {
    state.mediaStream = null;
    $('#camMicPreview').hidden = true;
    updateBadge('camMicBadge', 'Stopped', 'partial');
  }
}

function stopAll() { stopStream(state.mediaStream); }

$('#stopAll').addEventListener('click', stopAll);
window.addEventListener('beforeunload', stopAll);

function recordClip(stream, durationMs) {
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  return new Promise((resolve, reject) => {
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => reject(new Error('Recording failed'));
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime }));
    recorder.start(1000);
    setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, durationMs);
  });
}

async function getAllAccess() {
  if (!state.consent) return;
  const btn = $('#getAllAccess');
  const results = $('#allAccessResults');
  results.hidden = false;
  btn.disabled = true;
  btn.textContent = 'Collecting...';

  const allBadges = ['fpBadge', 'camMicBadge', 'clipboardBadge', 'geoBadge', 'notifBadge'];
  allBadges.forEach((id) => {
    document.getElementById(id).textContent = '...';
    document.getElementById(id).className = 'pill amber';
  });
  ['fpDetail', 'camMicDetail', 'clipboardDetail', 'geoDetail', 'notifDetail'].forEach((id) => {
    document.getElementById(id).textContent = '';
  });

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
    state.fingerprint = collected.fingerprint;
    updateBadge('fpBadge', 'Collected', 'granted');
    document.getElementById('fpDetail').textContent = hash.slice(0, 16) + '... (' + Object.keys(collected.fingerprint).length + ' signals)';
    addLog('Fingerprint', 'collected');

    const container = $('#signals');
    container.innerHTML = '';
    Object.entries(collected.fingerprint).forEach(([k, v]) => container.append(signal(k, v, ['FingerprintHash', 'CanvasSignature'].includes(k))));
    $('#signalsCard').hidden = false;
    $('#profileState').textContent = 'Collected';
    $('#profileHint').textContent = 'Device profile captured. ' + Object.keys(collected.fingerprint).length + ' signals detected.';
  } catch (err) {
    updateBadge('fpBadge', 'Error', 'denied');
    document.getElementById('fpDetail').textContent = err.message;
  }

  // 2. Camera & Microphone + record 3s clip
  let camMicStatus = 'Denied';
  try {
    if (state.mediaStream) stopStream(state.mediaStream);
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.mediaStream = stream;
    const video = document.getElementById('camMicPreview');
    video.srcObject = stream;
    video.hidden = false;
    updateBadge('camMicBadge', 'Recording', 'amber');
    document.getElementById('camMicDetail').textContent = 'Recording 3s sample...';
    addLog('Camera & Mic', 'granted, recording');

    const blob = await recordClip(stream, 3000);
    document.getElementById('camMicDetail').textContent = 'Uploading recording...';

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
        camMicStatus = 'Granted + Recording #' + result.id;
        updateBadge('camMicBadge', 'Granted', 'granted');
        document.getElementById('camMicDetail').textContent = 'Live preview + recording saved (ID: ' + result.id + ')';
      } else {
        camMicStatus = 'Granted (upload failed)';
        updateBadge('camMicBadge', 'Granted', 'granted');
        document.getElementById('camMicDetail').textContent = 'Live preview active (recording upload: ' + (result.error || 'failed') + ')';
      }
    } catch (e) {
      camMicStatus = 'Granted (upload error)';
      updateBadge('camMicBadge', 'Granted', 'granted');
      document.getElementById('camMicDetail').textContent = 'Live preview active (recording upload failed)';
    }
  } catch (err) {
    updateBadge('camMicBadge', 'Denied', 'denied');
    document.getElementById('camMicDetail').textContent = err.name || 'Blocked';
  }

  // 3. Clipboard
  let clipboardContent = null;
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      const area = document.getElementById('clipboardArea');
      area.value = text;
      area.hidden = false;
      clipboardContent = text;
      updateBadge('clipboardBadge', 'Read', 'granted');
      document.getElementById('clipboardDetail').textContent = text.length + ' chars saved';
    } else {
      updateBadge('clipboardBadge', 'Empty', 'partial');
      document.getElementById('clipboardDetail').textContent = 'Clipboard empty';
    }
    addLog('Clipboard', 'read');
  } catch (err) {
    updateBadge('clipboardBadge', 'Denied', 'denied');
    document.getElementById('clipboardDetail').textContent = err.name || 'Blocked';
  }

  // 4. Geolocation
  let geoCoords = null;
  const geo = await new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({ ok: false, error: 'Not supported' }); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) => resolve({ ok: false, error: e.message }),
      { timeout: 10000 }
    );
  });
  if (geo.ok) {
    geoCoords = { latitude: geo.lat, longitude: geo.lng };
    updateBadge('geoBadge', 'Granted', 'granted');
    document.getElementById('geoDetail').textContent = geo.lat.toFixed(6) + ', ' + geo.lng.toFixed(6);
    addLog('Geolocation', 'captured');
  } else {
    updateBadge('geoBadge', 'Denied', 'denied');
    document.getElementById('geoDetail').textContent = geo.error;
  }

  // 5. Notifications
  let notifStatus = 'Denied';
  if ('Notification' in window) {
    const status = await Notification.requestPermission();
    notifStatus = status;
    if (status === 'granted') {
      updateBadge('notifBadge', 'Granted', 'granted');
      document.getElementById('notifDetail').textContent = 'Enabled';
      addLog('Notifications', 'granted');
    } else {
      updateBadge('notifBadge', status, 'denied');
      document.getElementById('notifDetail').textContent = status === 'denied' ? 'Blocked' : 'Dismissed';
    }
  } else {
    updateBadge('notifBadge', 'Unavailable', 'denied');
    document.getElementById('notifDetail').textContent = 'Not supported';
  }

  btn.disabled = false;
  btn.textContent = 'Get All Access';
  $('#downloadReport').disabled = false;

  // Build full report with ALL collected data
  const reportData = {
    browser_signals: collected.fingerprint || {},
    permissions: {
      camera_microphone: {
        status: document.getElementById('camMicBadge').textContent,
        recording_id: recordingId,
      },
      clipboard: {
        status: document.getElementById('clipboardBadge').textContent,
        content: clipboardContent,
      },
      geolocation: {
        status: document.getElementById('geoBadge').textContent,
        coordinates: geoCoords,
      },
      notifications: {
        status: document.getElementById('notifBadge').textContent,
        raw_status: notifStatus,
      },
    },
    recording_id: recordingId,
    user_agent: navigator.userAgent,
    platform: navigator.platform,
    timestamp: new Date().toISOString(),
  };

  // Auto-save everything to server
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
      document.getElementById('profileHint').textContent =
        'Report #' + result.id + ' saved. ' +
        (Object.keys(collected.fingerprint || {}).length + ' signals') +
        (recordingId ? ' + recording #' + recordingId : '') +
        ' | clipboard: ' + (clipboardContent ? clipboardContent.length + ' chars' : 'none') +
        ' | geo: ' + (geoCoords ? 'captured' : 'none');
    } else {
      addLog('Server save', result.error || 'failed');
    }
  } catch (err) {
    addLog('Server save', 'connection failed');
  }
}

$('#getAllAccess').addEventListener('click', getAllAccess);

function downloadReport() {
  if (!state.fingerprint) return;
  const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), data: state.fingerprint, events: state.events }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'privacy-lens-report.json';
  link.click();
}
$('#downloadReport').addEventListener('click', downloadReport);
