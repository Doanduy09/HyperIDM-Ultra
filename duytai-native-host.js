// Duytai 64-Bit Native Messaging Host (Chrome / Edge / CocCoc / Brave / Firefox stdio bridge)
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.HYPER_IDM_PORT || '17890', 10);

function readAuthToken() {
  const userHome = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const candidates = [
    process.env.DUYTAI_TOKEN_FILE,
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || __dirname, 'Duytai', 'auth.token')
      : process.platform === 'darwin'
        ? path.join(userHome, 'Library', 'Application Support', 'Duytai', 'auth.token')
        : path.join(userHome, '.config', 'duytai', 'auth.token'),
    path.join(__dirname, 'auth.token')
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const tok = fs.readFileSync(p, 'utf8').trim();
        if (tok) return tok;
      }
    } catch {}
  }
  return '';
}

let buf = Buffer.alloc(0);
let pendingCount = 0;
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && pendingCount <= 0) {
    process.exit(0);
  }
}

function sendNativeMessage(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  process.stdout.write(Buffer.concat([header, payload]));
}

function postIntercept(msg) {
  return new Promise((resolve, reject) => {
    const token = readAuthToken();
    if (!token) return reject(new Error('Token unavailable'));
    const data = Buffer.from(JSON.stringify(msg), 'utf8');
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/intercept',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'X-Duytai-Token': token
      },
      timeout: 2500
    }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(body)); } catch { resolve({ ok: true }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

function tryWakeDuytai() {
  try {
    if (process.platform === 'win32') {
      const exe = path.join(__dirname, 'Duytai.exe');
      spawn('explorer.exe', [exe], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Duytai'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn(process.execPath, [path.join(__dirname, 'server.js')], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {}
}

async function handleMessage(msg) {
  pendingCount++;
  try {
    if (msg && msg.action === 'get-token') {
      let tok = readAuthToken();
      if (!tok) {
        tryWakeDuytai();
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 450));
          tok = readAuthToken();
          if (tok) break;
        }
      }
      if (tok) return sendNativeMessage({ ok: true, token: tok });
      return sendNativeMessage({ ok: false, error: 'Duytai token unavailable' });
    }
    const res = await postIntercept(msg);
    sendNativeMessage({ ok: true, ...res });
  } catch {
    tryWakeDuytai();
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 450));
      try {
        const res = await postIntercept(msg);
        sendNativeMessage({ ok: true, wokeApp: true, ...res });
        return;
      } catch {}
    }
    sendNativeMessage({ ok: false, error: 'Duytai daemon unavailable' });
  } finally {
    pendingCount--;
    maybeExit();
  }
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (len === 0 || len > 1024 * 1024) { process.exit(0); }
    if (buf.length < 4 + len) break;
    const jsonBuf = buf.subarray(4, 4 + len);
    buf = buf.subarray(4 + len);
    try {
      handleMessage(JSON.parse(jsonBuf.toString('utf8')));
    } catch (e) {
      sendNativeMessage({ ok: false, error: e.message });
    }
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
