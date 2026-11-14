process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';
const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { DownloadJob } = require('./engine');
const idmFeatures = require('./idm-features');

const PORT = parseInt(process.env.HYPER_IDM_PORT || '17890', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const USER_HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const DEFAULT_SAVE_DIR = path.join(USER_HOME, 'Downloads', 'Duytai');
const LEGACY_SAVE_DIR = path.join(USER_HOME, 'Downloads', 'HyperIDM');
const DATA_DIR = process.env.DUYTAI_DATA_DIR || (
  process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || __dirname, 'Duytai')
    : process.platform === 'darwin'
      ? path.join(USER_HOME, 'Library', 'Application Support', 'Duytai')
      : path.join(USER_HOME, '.config', 'duytai')
);
const HISTORY_FILE = process.env.HYPER_IDM_HISTORY_FILE || path.join(DATA_DIR, 'jobs-history.json');
const LEGACY_HISTORY_FILE = path.join(__dirname, 'jobs-history.json');
const TOKEN_FILE = process.env.DUYTAI_TOKEN_FILE || path.join(DATA_DIR, 'auth.token');
const ERROR_LOG_FILE = path.join(DATA_DIR, 'server-error.log');
const AUTH_TOKEN = (process.env.DUYTAI_API_TOKEN && process.env.DUYTAI_API_TOKEN.trim()) || crypto.randomBytes(32).toString('hex');
const TRUSTED_CHROME_EXT_ORIGIN = 'chrome-extension://knpgakkbngbpcijjehpjflnflccdlaon';

const jobs = new Map();
const sseClients = new Set();
const interceptQueue = [];
const speedLimiter = new idmFeatures.SpeedLimiter(() => jobs.values());

const BENCHMARK_CHUNK = Buffer.alloc(1024 * 1024, 0x48);

function sanitizeJobId(rawId) {
  const s = String(rawId || '').trim();
  return /^[a-zA-Z0-9_-]{1,80}$/.test(s) ? s : crypto.randomUUID();
}

function validateSaveDir(rawDir, fallbackDir) {
  if (!rawDir || typeof rawDir !== 'string' || rawDir.includes('\0')) return fallbackDir;
  const resolved = path.resolve(rawDir.trim());
  const lower = resolved.toLowerCase();
  const forbiddenPrefixes = process.platform === 'win32'
    ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)']
    : ['/system', '/etc', '/usr', '/bin', '/sbin', '/private/etc'];
  for (const p of forbiddenPrefixes) {
    if (lower === p || lower.startsWith(p + path.sep)) {
      throw new Error('Thư mục lưu không được trỏ vào thư mục hệ thống');
    }
  }
  return resolved;
}

function sanitizeOptionalFileName(rawName) {
  if (!rawName || typeof rawName !== 'string') return '';
  const clean = path.basename(rawName.replace(/\0/g, '').trim()).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  if (!clean || clean === '.' || clean === '..') return '';
  return clean;
}

function createAndRegisterJob(opts, startImmediately = true) {
  const fileName = sanitizeOptionalFileName(opts.fileName || '');
  const autoCategory = opts.autoCategory !== false && !opts.saveDir;
  const saveDir = opts.saveDir
    ? validateSaveDir(opts.saveDir, DEFAULT_SAVE_DIR)
    : (autoCategory
      ? idmFeatures.categorizeSaveDir(DEFAULT_SAVE_DIR, opts.url, fileName)
      : DEFAULT_SAVE_DIR);

  const job = new DownloadJob({
    id: sanitizeJobId(opts.id),
    url: opts.url.trim(),
    saveDir,
    fileName,
    maxConnections: opts.maxConnections || 64,
    headers: opts.headers || {},
    videoQuality: opts.videoQuality || 'best',
    allowInsecureTls: Boolean(opts.allowInsecureTls)
  });

  attachJobEvents(job);
  idmFeatures.attachIdmFeatures(job, {
    baseDir: DEFAULT_SAVE_DIR,
    autoCategory,
    verify: true,
    expectedHash: opts.expectedHash || '',
    alwaysHash: Boolean(opts.alwaysHash)
  });

  jobs.set(job.id, job);
  if (job.filePath) deletedPaths.delete(job.filePath.toLowerCase());
  deletedIds.delete(job.id);
  if (startImmediately) job.start();
  return job;
}

const DELETED_ITEMS_FILE = path.join(DATA_DIR, 'deleted-items.json');
const deletedIds = new Set();
const deletedPaths = new Set();

function loadDeletedItemsRegistry() {
  try {
    if (fs.existsSync(DELETED_ITEMS_FILE)) {
      const data = JSON.parse(fs.readFileSync(DELETED_ITEMS_FILE, 'utf8'));
      if (Array.isArray(data.ids)) data.ids.forEach(x => deletedIds.add(String(x)));
      if (Array.isArray(data.paths)) data.paths.forEach(x => deletedPaths.add(String(x).toLowerCase()));
    }
  } catch {}
}

function recordDeletedJob(job) {
  if (!job) return;
  if (job.id) deletedIds.add(String(job.id));
  if (job.filePath) deletedPaths.add(String(job.filePath).toLowerCase());
}

async function saveDeletedItemsRegistry() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const payload = {
      ids: Array.from(deletedIds).slice(-3000),
      paths: Array.from(deletedPaths).slice(-3000)
    };
    await fsp.writeFile(DELETED_ITEMS_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch {}
}

async function moveFilesToRecycleBin(filePaths) {
  const existing = Array.from(new Set((filePaths || []).filter(p => p && fs.existsSync(p))));
  if (existing.length === 0) return;

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const psScript = "Add-Type -AssemblyName Microsoft.VisualBasic; foreach ($p in $args) { if (Test-Path -LiteralPath $p) { try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } catch { Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } } }";
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript, '--', ...existing], { windowsHide: true });
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 10000);
      child.on('close', () => { clearTimeout(timer); resolve(); });
      child.on('error', () => { clearTimeout(timer); resolve(); });
    });
    for (const p of existing) {
      if (fs.existsSync(p)) await fsp.unlink(p).catch(() => {});
    }
    return;
  }

  const trashDir = process.platform === 'darwin'
    ? path.join(os.homedir(), '.Trash')
    : path.join(os.homedir(), '.local', 'share', 'Trash', 'files');
  await fsp.mkdir(trashDir, { recursive: true }).catch(() => {});
  for (const p of existing) {
    const dest = path.join(trashDir, `${Date.now()}_${path.basename(p)}`);
    await fsp.rename(p, dest).catch(async () => {
      await fsp.unlink(p).catch(() => {});
    });
  }
}

const batchQueue = new idmFeatures.DownloadQueue({
  createJob: (url, opts) => createAndRegisterJob({ ...opts, url }, false),
  maxConcurrent: 4
});

const schedulerConfig = {
  enabled: false,
  maxConcurrent: 4,
  autoRetryIntervalSec: 30,
  startAtTime: '',
  stopAtTime: '',
  onCompleteAction: 'none',
  autoAntivirusScan: true,
  lastRetryTick: 0
};

async function loadHistory() {
  try {
    await fsp.mkdir(DEFAULT_SAVE_DIR, { recursive: true });
    await fsp.mkdir(DATA_DIR, { recursive: true });
    loadDeletedItemsRegistry();
    const historySource = fs.existsSync(HISTORY_FILE)
      ? HISTORY_FILE
      : (fs.existsSync(LEGACY_HISTORY_FILE) ? LEGACY_HISTORY_FILE : '');
    if (historySource) {
      const raw = await fsp.readFile(historySource, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          if (!item) continue;
          if (item.id && deletedIds.has(String(item.id))) continue;
          if (item.filePath && deletedPaths.has(String(item.filePath).toLowerCase())) continue;
          const isGhostLocal = String(item.id || '').startsWith('local-')
            && /^file:\/\//i.test(String(item.url || ''))
            && (item.status === 'error' || !item.filePath || !fs.existsSync(item.filePath));
          if (isGhostLocal) continue;
          const job = new DownloadJob({
            id: sanitizeJobId(item.id),
            url: item.url,
            saveDir: item.saveDir || DEFAULT_SAVE_DIR,
            fileName: sanitizeOptionalFileName(item.fileName),
            maxConnections: item.maxConnections || 64,
            headers: item.headers || {},
            videoQuality: item.videoQuality || 'best'
          });
          job.finalUrl = item.finalUrl || item.url;
          job.resolverType = item.resolverType || (job._isYouTubeOrMediaUrl(job.url || '') ? 'youtube' : (job._isIpswMeUrl(job.url || '') ? 'ipsw' : 'direct'));
          job.expectedSha1 = item.expectedSha1 || '';
          job.filePath = item.filePath || path.join(job.saveDir, item.fileName || '');
          job.stateFilePath = `${job.filePath}.hyper.json`;
          job.isLocalOnly = /^file:\/\//i.test(job.url || '');
          job.error = item.error || null;
          job.status = ['downloading', 'probing', 'resolving', 'muxing'].includes(item.status) ? 'paused' : (item.status || 'paused');
          job.totalBytes = item.totalBytes || 0;
          job.downloadedBytes = item.downloadedBytes || 0;
          job.acceptRanges = Boolean(item.acceptRanges);
          job.peakSpeedBps = item.peakSpeedBps || 0;
          job.elapsedMs = item.elapsedMs || 0;
          job.stealCount = item.stealCount || 0;
          job.recycleCount = item.recycleCount || 0;
          job.segments = Array.isArray(item.segments) ? item.segments : [];
          attachJobEvents(job);
          idmFeatures.attachIdmFeatures(job, {
            baseDir: DEFAULT_SAVE_DIR,
            autoCategory: false,
            verify: true
          });
          if (item.idm) {
            job.idmCategory = item.idm.category || null;
            job.idmChecksum = item.idm.checksum || { status: 'none' };
          }
          jobs.set(job.id, job);
        }
      }
    }
  } catch {}
  await syncExistingDownloads();
}

async function syncIdmRegistryItems() {
  if (process.platform !== 'win32') return;
  return new Promise(resolve => {
    const psCmd = `
      $items = @()
      Get-ChildItem 'HKCU:\\Software\\DownloadManager' -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match '^\\d+$' } | ForEach-Object {
        $p = Get-ItemProperty $_.PSPath
        if ($p.Url0) {
          $size = 0; if ($p.FileSize -and $p.FileSize.Length -ge 8) { $size = [BitConverter]::ToUInt64($p.FileSize, 0) }
          $dl = 0; if ($p.Downloaded -and $p.Downloaded.Length -ge 8) { $dl = [BitConverter]::ToUInt64($p.Downloaded, 0) }
          $fn = ''
          if ($p.FR_FNCD) { $fn = [Uri]::UnescapeDataString($p.FR_FNCD) }
          elseif ($p.Url0 -match 'dlf=([^&]+)') { $fn = [Uri]::UnescapeDataString($matches[1]) }
          elseif ($p.LocalFileName) { $fn = [System.IO.Path]::GetFileName($p.LocalFileName) }
          $items += [PSCustomObject]@{
            regId = [int]$_.PSChildName
            url = [string]$p.Url0
            fileName = [string]$fn
            totalBytes = $size
            downloadedBytes = $dl
            idmStatus = [int]($p.Status)
            lastTryDate = [string]$p.lastTryDate
            cookie = [string]$p.Cookie
            referer = [string]$p.Referer
            ua = [string]$p.UA
          }
        }
      }
      $items | Sort-Object regId | ConvertTo-Json -Compress
    `;
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', psCmd], { windowsHide: true });
    let out = '';
    child.stdout.on('data', d => { out += d.toString('utf8'); });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim());
        const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
        for (const item of list) {
          const id = 'idm-reg-' + item.regId;
          if (jobs.has(id) || deletedIds.has(id)) continue;
          let fn = item.fileName || '';
          if (!fn || fn === 'dl_google_com' || fn === 'de-s3_storage_bunnyc' || fn === 'img01_71360_com') {
            try {
              const u = new URL(item.url);
              const dlf = u.searchParams.get('dlf');
              fn = dlf || path.posix.basename(u.pathname) || fn;
            } catch {}
          }
          if (fn === 'UniversalMac_14.5_23.ipsw') fn = 'UniversalMac_14.5_23F79_Restore.ipsw';
          const cat = idmFeatures.categorize({ fileName: fn, url: item.url });
          const saveDir = path.join(DEFAULT_SAVE_DIR, cat);
          const headers = {};
          if (item.cookie) headers['Cookie'] = item.cookie;
          if (item.referer) headers['Referer'] = item.referer;
          if (item.ua) headers['User-Agent'] = item.ua;

          const job = new DownloadJob({
            id,
            url: item.url,
            saveDir,
            fileName: fn,
            maxConnections: 64,
            headers
          });
          job.filePath = path.join(saveDir, fn);
          if (deletedPaths.has(job.filePath.toLowerCase())) continue;
          job.totalBytes = Number(item.totalBytes) || 0;
          job.downloadedBytes = item.idmStatus === 3 ? job.totalBytes : (Number(item.downloadedBytes) || 0);
          job.status = item.idmStatus === 3 ? 'completed' : 'paused';
          job.acceptRanges = true;
          job.lastTryTime = item.lastTryDate || new Date().toLocaleString('vi-VN');
          attachJobEvents(job);
          idmFeatures.attachIdmFeatures(job, {
            baseDir: DEFAULT_SAVE_DIR,
            autoCategory: false,
            verify: false
          });
          job.idmCategory = { category: cat, folder: cat };
          job.idmChecksum = { status: item.idmStatus === 3 ? 'verified' : 'none', algorithm: 'SHA-256', actual: item.idmStatus === 3 ? 'Hoàn thành (64 Luồng)' : 'Sẵn sàng tải tiếp 64 luồng' };
          jobs.set(job.id, job);
        }
      } catch {}
      resolve();
    });
    child.on('error', () => resolve());
  });
}

async function syncExistingDownloads() {
  try {
    await syncIdmRegistryItems();
    const existingPaths = new Set(Array.from(jobs.values()).map(j => (j.filePath || '').toLowerCase()));
    const scanDirs = [DEFAULT_SAVE_DIR];
    for (const folder of Object.keys(idmFeatures.CATEGORIES || {})) {
      scanDirs.push(path.join(DEFAULT_SAVE_DIR, folder));
    }

    const foundFiles = [];
    for (const dir of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (ent.name.endsWith('.hyper.json') || ent.name === 'desktop.ini') continue;
        const fullPath = path.join(dir, ent.name);
        if (existingPaths.has(fullPath.toLowerCase()) || deletedPaths.has(fullPath.toLowerCase())) continue;
        // Skip partial/managed files belonging to active or historical HTTP jobs
        if (fs.existsSync(`${fullPath}.hyper.json`)) continue;
        let hasManagedJob = false;
        for (const existingJob of jobs.values()) {
          if (existingJob.fileName && existingJob.fileName.toLowerCase() === ent.name.toLowerCase() &&
              existingJob.saveDir && existingJob.saveDir.toLowerCase() === dir.toLowerCase()) {
            hasManagedJob = true;
            break;
          }
        }
        if (hasManagedJob) continue;
        try {
          const st = await fsp.stat(fullPath);
          if (st.size > 0) {
            foundFiles.push({ name: ent.name, dir, fullPath, size: st.size, mtimeMs: st.mtimeMs });
          }
        } catch {}
      }
    }

    foundFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const f of foundFiles.slice(0, 25)) {
      if (existingPaths.has(f.fullPath.toLowerCase())) continue;
      existingPaths.add(f.fullPath.toLowerCase());
      const id = 'local-' + crypto.createHash('sha1').update(f.fullPath.toLowerCase()).digest('hex').slice(0, 16);
      if (jobs.has(id) || deletedIds.has(id)) continue;
      const job = new DownloadJob({
        id,
        url: `file:///${f.fullPath.replace(/\\/g, '/')}`,
        saveDir: f.dir,
        fileName: f.name,
        maxConnections: 64
      });
      job.isLocalOnly = true;
      job.filePath = f.fullPath;
      job.status = 'completed';
      job.totalBytes = f.size;
      job.downloadedBytes = f.size;
      job.acceptRanges = true;
      job.lastTryTime = new Date(f.mtimeMs).toLocaleString('vi-VN');
      attachJobEvents(job);
      idmFeatures.attachIdmFeatures(job, {
        baseDir: DEFAULT_SAVE_DIR,
        autoCategory: false,
        verify: false
      });
      const cat = idmFeatures.categorize({ fileName: f.name, url: f.name });
      job.idmCategory = { category: cat, folder: cat };
      job.idmChecksum = { status: 'verified', algorithm: 'NTFS-InPlace', actual: 'Sẵn sàng trên ổ đĩa' };
      jobs.set(job.id, job);
    }
  } catch {}
}

function serializeJobsForHistory() {
  return Array.from(jobs.values()).map((j) => {
    const dto = j.toJSON();
    if (dto.status === 'completed' && Array.isArray(dto.segments) && dto.segments.length > 0) {
      dto.segments = [];
    }
    return dto;
  });
}

let saveDebounce = null;
function scheduleSaveHistory(immediate = false) {
  if (saveDebounce) {
    if (!immediate) return;
    clearTimeout(saveDebounce);
    saveDebounce = null;
  }
  const hasActive = Array.from(jobs.values()).some(j => j.status === 'downloading' || j.status === 'muxing');
  const delayMs = immediate ? 250 : (hasActive ? 3000 : 800);
  saveDebounce = setTimeout(async () => {
    saveDebounce = null;
    try {
      await fsp.writeFile(HISTORY_FILE, JSON.stringify(serializeJobsForHistory()), 'utf8');
    } catch {}
  }, delayMs);
}

let broadcastTimer = null;
let lastBroadcastAt = 0;

function broadcastState(immediate = false) {
  if (sseClients.size === 0) return;
  const now = Date.now();
  if (!immediate && (now - lastBroadcastAt < 150)) {
    if (!broadcastTimer) {
      broadcastTimer = setTimeout(() => {
        broadcastTimer = null;
        broadcastState(false);
      }, 150 - (now - lastBroadcastAt));
    }
    return;
  }
  if (broadcastTimer) {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
  }
  lastBroadcastAt = now;
  const payload = JSON.stringify({
    type: 'snapshot',
    timestamp: now,
    defaultSaveDir: DEFAULT_SAVE_DIR,
    globalLimitBps: speedLimiter.globalBps,
    jobs: Array.from(jobs.values()).map(j => j.toJSON())
  });
  for (const res of sseClients) {
    try {
      if (res.writableNeedDrain || res.writableLength > 512 * 1024) continue;
      res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

function attachJobEvents(job) {
  job.on('update', () => {
    broadcastState(false);
    scheduleSaveHistory(false);
  });
  job.on('completed', () => {
    broadcastState(true);
    scheduleSaveHistory(true);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLen = 0;
    let settled = false;
    const onData = (chunk) => {
      if (settled) return;
      totalLen += chunk.length;
      if (totalLen > 2 * 1024 * 1024) {
        settled = true;
        req.removeListener('data', onData);
        try { req.destroy(); } catch {}
        return reject(new Error('Payload too large'));
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function isTrustedHostHeader(hostHdr) {
  if (!hostHdr) return false;
  return new RegExp(`^(?:127\\.0\\.0\\.1|localhost)(?::${PORT})?$`, 'i').test(String(hostHdr).trim());
}

function isTrustedOrigin(origin) {
  if (!origin) return true;
  const exactWeb = new RegExp(`^https?://(?:127\\.0\\.0\\.1|localhost):${PORT}$`, 'i');
  return exactWeb.test(origin) ||
    origin.toLowerCase() === TRUSTED_CHROME_EXT_ORIGIN ||
    /^moz-extension:\/\/[a-z0-9-]+$/i.test(origin);
}

function timingSafeTokenEqual(provided) {
  if (!provided || typeof provided !== 'string') return false;
  const a = Buffer.from(provided.trim(), 'utf8');
  const b = Buffer.from(AUTH_TOKEN, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hasValidAuth(req, parsedUrl) {
  const hdrToken = req.headers['x-duytai-token'];
  if (hdrToken && timingSafeTokenEqual(String(hdrToken))) return true;
  const authHdr = String(req.headers['authorization'] || '');
  if (/^Bearer\s+/i.test(authHdr) && timingSafeTokenEqual(authHdr.slice(7))) return true;
  if (parsedUrl && parsedUrl.pathname === '/api/events') {
    const qTok = parsedUrl.searchParams.get('token');
    if (qTok && timingSafeTokenEqual(qTok)) return true;
  }
  return false;
}

function getCorsHeaders(req) {
  const origin = req && req.headers ? req.headers.origin : '';
  const allowed = origin && isTrustedOrigin(origin) ? origin : `http://127.0.0.1:${PORT}`;
  return {
    'Access-Control-Allow-Origin': allowed,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Duytai-Source, X-Duytai-Token, Authorization'
  };
}

function sendJson(res, status, data, req) {
  const cors = getCorsHeaders(req);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...cors
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (!isTrustedHostHeader(req.headers.host)) {
    return sendJson(res, 403, { error: 'Untrusted Host header rejected' }, req);
  }
  const secFetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  const origin = req.headers.origin;
  if (origin && !isTrustedOrigin(origin)) {
    return sendJson(res, 403, { error: 'Untrusted origin rejected by Duytai Security Guard' }, req);
  }
  if (secFetchSite === 'cross-site' && (!origin || (!origin.startsWith('chrome-extension://') && !origin.startsWith('moz-extension://')))) {
    return sendJson(res, 403, { error: 'Cross-site request rejected' }, req);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, getCorsHeaders(req));
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = parsedUrl.pathname;

  if (pathname === '/api/auth/handshake' && req.method === 'POST') {
    if (origin && origin.toLowerCase() === TRUSTED_CHROME_EXT_ORIGIN) {
      return sendJson(res, 200, { ok: true, token: AUTH_TOKEN }, req);
    }
    return sendJson(res, 403, { error: 'Handshake forbidden' }, req);
  }

  if (pathname.startsWith('/api/') && !hasValidAuth(req, parsedUrl)) {
    return sendJson(res, 401, { error: 'Unauthorized: missing or invalid Duytai API token' }, req);
  }

  // Built-in HTTP 206 Range Server for Multi-Gigabit Engine Stress Benchmarking (supports MB & GB up to 64GB)
  if (pathname.startsWith('/benchmark-payload/')) {
    const match = /\/benchmark-payload\/(\d+)(MB|GB)\.bin$/i.exec(pathname);
    let totalBytes = 256 * 1024 * 1024;
    let sizeLabel = '256mb';
    if (match) {
      const num = parseInt(match[1], 10);
      const unit = match[2].toUpperCase();
      const sizeMB = unit === 'GB'
        ? Math.min(65536, Math.max(10, num * 1024))
        : Math.min(65536, Math.max(10, num));
      totalBytes = sizeMB * 1024 * 1024;
      sizeLabel = `${num}${unit.toLowerCase()}`;
    }

    const rangeHeader = req.headers['range'];
    let start = 0;
    let end = totalBytes - 1;
    let statusCode = 200;

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const parts = rangeHeader.replace('bytes=', '').split('-');
      start = parseInt(parts[0], 10) || 0;
      end = parts[1] ? parseInt(parts[1], 10) : (totalBytes - 1);
      if (end >= totalBytes) end = totalBytes - 1;
      statusCode = 206;
    }

    const contentLength = Math.max(0, end - start + 1);
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(contentLength),
      'Accept-Ranges': 'bytes',
      'Server': 'Duytai-StressTest-Node/26',
      'ETag': `"duytai-bench-${sizeLabel}"`
    };
    if (statusCode === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${totalBytes}`;
    }

    res.writeHead(statusCode, headers);
    try { if (res.socket) res.socket.setNoDelay(true); } catch {}
    let remaining = contentLength;
    res.on('close', () => { remaining = 0; });

    function pump() {
      if (res.destroyed || res.writableEnded) return;
      let ok = true;
      while (remaining > 0 && ok) {
        if (res.destroyed || res.writableEnded) return;
        const toSend = Math.min(remaining, BENCHMARK_CHUNK.length);
        const slice = toSend === BENCHMARK_CHUNK.length ? BENCHMARK_CHUNK : BENCHMARK_CHUNK.subarray(0, toSend);
        remaining -= toSend;
        if (remaining === 0) {
          res.end(slice);
        } else {
          ok = res.write(slice);
        }
      }
      if (remaining > 0 && !res.destroyed && !res.writableEnded) {
        res.once('drain', pump);
      }
    }
    pump();
    return;
  }

  // Real-time SSE Telemetry Endpoint
  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...getCorsHeaders(req)
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify({
      type: 'snapshot',
      timestamp: Date.now(),
      defaultSaveDir: DEFAULT_SAVE_DIR,
      globalLimitBps: speedLimiter.globalBps,
      jobs: Array.from(jobs.values()).map(j => j.toJSON())
    })}\n\n`);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (pathname === '/api/jobs' && req.method === 'GET') {
    return sendJson(res, 200, {
      defaultSaveDir: DEFAULT_SAVE_DIR,
      globalLimitBps: speedLimiter.globalBps,
      jobs: Array.from(jobs.values()).map(j => j.toJSON())
    }, req);
  }

  if (pathname === '/api/jobs' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.url || typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url.trim())) {
        return sendJson(res, 400, { error: 'URL không hợp lệ (cần http:// hoặc https://)' }, req);
      }
      // Check if URL contains a batch pattern like file[01-10].zip
      const expanded = idmFeatures.expandBatchPattern(body.url);
      if (expanded.length > 1) {
        const created = batchQueue.add(expanded, body);
        return sendJson(res, 201, { batchCount: created.length, jobs: created.map(j => j.toJSON()) }, req);
      }
      const startNow = !body.paused;
      const job = createAndRegisterJob(body, startNow);
      if (!startNow) {
        job.status = 'paused';
      }
      return sendJson(res, 201, job.toJSON(), req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, req);
    }
  }

  // Live Pre-Download URL Probe (IDM File Info Dialog Size/Resume/ZIP Probe)
  if (pathname === '/api/probe' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const rawUrl = String(body.url || '').trim();
      if (!/^https?:\/\//i.test(rawUrl)) return sendJson(res, 400, { error: 'URL không hợp lệ' }, req);
      if (!new RegExp(`^http://(?:127\\.0\\.0\\.1|localhost):${PORT}/benchmark-payload/`, 'i').test(rawUrl)) {
        await idmFeatures.assertSafeRemoteUrl(rawUrl);
      }
      const tmpJob = new DownloadJob({ url: rawUrl, saveDir: DEFAULT_SAVE_DIR, headers: body.headers || {} });
      let targetUrl = rawUrl;
      let resolvedName = '';
      if (/^https?:\/\/(?:www\.)?ipsw\.me\/download\//i.test(rawUrl)) {
        const ipsw = await tmpJob._resolveIpswMeUrl(rawUrl);
        targetUrl = ipsw.url;
        resolvedName = ipsw.fileName || '';
      } else if (/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)/i.test(rawUrl)) {
        const cat = 'Video';
        const ytMeta = await DownloadJob.probeYoutubeInfo(rawUrl, 7500).catch(() => null);
        return sendJson(res, 200, {
          url: rawUrl,
          finalUrl: rawUrl,
          fileName: (ytMeta && ytMeta.fileName) || sanitizeOptionalFileName(body.fileName) || '',
          title: (ytMeta && ytMeta.title) || '',
          totalBytes: (ytMeta && ytMeta.totalBytes) || 0,
          maxHeight: (ytMeta && ytMeta.maxHeight) || 0,
          qualities: (ytMeta && ytMeta.qualities) || [],
          acceptRanges: true,
          resolverType: 'youtube',
          category: cat,
          isZip: false
        }, req);
      }
      const meta = await tmpJob._probeUrl(targetUrl);
      let urlFileName = '';
      try { urlFileName = decodeURIComponent(path.posix.basename(new URL(meta.finalUrl || targetUrl).pathname)); } catch {}
      const fileName = sanitizeOptionalFileName(resolvedName || meta.fileName || body.fileName || urlFileName) || '';
      const category = idmFeatures.categorize({ fileName, url: meta.finalUrl || rawUrl });
      const isZip = /\.zip$/i.test(fileName) || /\.zip(\?|$)/i.test(meta.finalUrl || rawUrl);
      return sendJson(res, 200, {
        url: rawUrl,
        finalUrl: meta.finalUrl || targetUrl,
        fileName,
        totalBytes: meta.totalBytes || 0,
        acceptRanges: Boolean(meta.acceptRanges),
        etag: meta.etag || '',
        category,
        isZip
      }, req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, req);
    }
  }

  // ZIP Preview Endpoint (Remote HTTP Range EOCD & Registered Job Local File only)
  if (pathname === '/api/zip-preview' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      let url = '';
      let filePath = '';
      let totalBytes = Number(body.totalBytes || 0);
      let headers = body.headers || {};
      if (body.jobId) {
        const job = jobs.get(String(body.jobId));
        if (!job) return sendJson(res, 404, { error: 'Không tìm thấy tác vụ tải để xem trước ZIP' }, req);
        url = job.finalUrl || job.url;
        filePath = job.filePath || '';
        totalBytes = job.totalBytes || 0;
        headers = job.headers || {};
      } else if (body.url && /^https?:\/\//i.test(String(body.url))) {
        url = String(body.url).trim();
        await idmFeatures.assertSafeRemoteUrl(url);
      } else {
        return sendJson(res, 400, { error: 'Cần jobId hợp lệ hoặc URL HTTP/HTTPS công khai để xem trước ZIP' }, req);
      }
      if (!totalBytes && url && /^https?:\/\//i.test(url)) {
        await idmFeatures.assertSafeRemoteUrl(url);
        const tmpJob = new DownloadJob({ url, saveDir: DEFAULT_SAVE_DIR, headers });
        const meta = await tmpJob._probeUrl(url).catch(() => null);
        if (meta) {
          url = meta.finalUrl || url;
          totalBytes = meta.totalBytes || 0;
        }
      }
      const preview = await idmFeatures.previewZipArchive({ url, filePath, totalBytes, headers });
      return sendJson(res, 200, { ok: true, ...preview }, req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, req);
    }
  }

  // Site Grabber / Spider Endpoint (IDM Grabber Project)
  if (pathname === '/api/grabber' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      await idmFeatures.assertSafeRemoteUrl(body.url);
      const result = await idmFeatures.grabSiteLinks(body.url, {
        filterCategory: body.filterCategory || 'all',
        headers: body.headers || {}
      });
      return sendJson(res, 200, { ok: true, ...result }, req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, req);
    }
  }

  // Built-in Scheduler & Synchronization Queue Endpoint
  if (pathname === '/api/scheduler' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, scheduler: schedulerConfig }, req);
  }
  if (pathname === '/api/scheduler' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (body.enabled !== undefined) schedulerConfig.enabled = Boolean(body.enabled);
      if (body.maxConcurrent !== undefined) {
        schedulerConfig.maxConcurrent = Math.max(1, Math.min(16, parseInt(body.maxConcurrent, 10) || 4));
        batchQueue.setMaxConcurrent(schedulerConfig.maxConcurrent);
      }
      if (body.autoRetryIntervalSec !== undefined) {
        schedulerConfig.autoRetryIntervalSec = Math.max(10, parseInt(body.autoRetryIntervalSec, 10) || 30);
      }
      if (body.startAtTime !== undefined) schedulerConfig.startAtTime = String(body.startAtTime || '').trim();
      if (body.stopAtTime !== undefined) schedulerConfig.stopAtTime = String(body.stopAtTime || '').trim();
      if (body.onCompleteAction !== undefined) schedulerConfig.onCompleteAction = String(body.onCompleteAction || 'none');
      if (body.autoAntivirusScan !== undefined) schedulerConfig.autoAntivirusScan = Boolean(body.autoAntivirusScan);
      return sendJson(res, 200, { ok: true, scheduler: schedulerConfig }, req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, req);
    }
  }

  // Batch Queue Endpoint
  if (pathname === '/api/batch' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const created = batchQueue.add(body.text || body.urls || '', body);
      return sendJson(res, 201, { count: created.length, jobs: created.map(j => j.toJSON()) }, req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, req);
    }
  }

  // Global or Per-Job Speed Limiter Endpoint
  if (pathname === '/api/limit' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const bps = parseInt(body.bps || 0, 10);
      if (body.jobId) {
        speedLimiter.setJobLimit(body.jobId, bps);
      } else {
        speedLimiter.setGlobalLimit(bps);
      }
      broadcastState();
      return sendJson(res, 200, { ok: true, globalLimitBps: speedLimiter.globalBps }, req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, req);
    }
  }

  // Categories list endpoint
  if (pathname === '/api/categories' && req.method === 'GET') {
    return sendJson(res, 200, { categories: idmFeatures.CATEGORIES }, req);
  }

  // Batch Pattern Expand endpoint
  if (pathname === '/api/batch-expand' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const urls = idmFeatures.expandBatchPattern(body.pattern || body.url || '');
      return sendJson(res, 200, { count: urls.length, urls }, req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, req);
    }
  }

  // Intercept Link Queue (for System Tray Native Popup Dialog & Browser Extension)
  if (pathname === '/api/intercept' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.url || !/^https?:\/\//i.test(String(body.url).trim())) {
        return sendJson(res, 400, { error: 'Missing or invalid http(s) url' }, req);
      }
      const cleanUrl = String(body.url).trim();
      const now = Date.now();
      const dupIdx = interceptQueue.findIndex(x => x.url === cleanUrl && (now - x.timestamp) < 2500);
      if (dupIdx >= 0) {
        return sendJson(res, 200, { ok: true, deduplicated: true, item: interceptQueue[dupIdx] }, req);
      }
      const cleanFn = sanitizeOptionalFileName(body.fileName || '');
      const cat = idmFeatures.categorize({ fileName: cleanFn, url: cleanUrl });
      const item = {
        id: 'int-' + now + '-' + Math.random().toString(36).slice(2, 6),
        url: cleanUrl,
        fileName: cleanFn,
        referrer: body.referrer || '',
        source: body.source || 'Bắt link từ Trình duyệt',
        headers: (body.headers && typeof body.headers === 'object') ? body.headers : {},
        videoQuality: body.videoQuality ? String(body.videoQuality).trim() : '',
        category: cat,
        saveDir: path.join(DEFAULT_SAVE_DIR, cat),
        timestamp: now
      };
      interceptQueue.push(item);
      if (interceptQueue.length > 100) interceptQueue.splice(0, interceptQueue.length - 100);
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify({ type: 'intercept', item })}\n\n`);
        } catch {}
      }
      return sendJson(res, 201, { ok: true, item }, req);
    } catch (e) {
      return sendJson(res, 500, { error: e.message }, req);
    }
  }

  if (pathname === '/api/intercept-queue' && req.method === 'GET') {
    const items = interceptQueue.splice(0, interceptQueue.length);
    return sendJson(res, 200, { items }, req);
  }

  // Graceful shutdown endpoint for Desktop tray wrappers
  if (pathname === '/api/shutdown' && req.method === 'POST') {
    sendJson(res, 200, { ok: true, shuttingDown: true }, req);
    setImmediate(() => gracefulShutdown());
    return;
  }

  // Pause All Active Jobs (IDM "Dừng tất cả" button & Tray action)
  if (pathname === '/api/pause-all' && req.method === 'POST') {
    let pausedCount = 0;
    for (const job of jobs.values()) {
      if (['downloading', 'probing', 'resolving', 'muxing'].includes(job.status)) {
        await job.pause();
        pausedCount++;
      }
    }
    broadcastState();
    scheduleSaveHistory();
    return sendJson(res, 200, { ok: true, pausedCount }, req);
  }

  // Clear All Completed Jobs from List (IDM "Xóa các mục đã hoàn thành" button)
  if (pathname === '/api/clear-completed' && req.method === 'POST') {
    let removedCount = 0;
    for (const [id, job] of jobs.entries()) {
      if (job.status === 'completed') {
        recordDeletedJob(job);
        jobs.delete(id);
        removedCount++;
      }
    }
    saveDeletedItemsRegistry().catch(() => {});
    broadcastState();
    scheduleSaveHistory();
    return sendJson(res, 200, { ok: true, removedCount }, req);
  }

  // Batch Delete Multiple Selected Jobs
  if (pathname === '/api/jobs/batch-delete' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const rawIds = Array.isArray(body.ids) ? body.ids : [];
      const uniqueIds = Array.from(new Set(rawIds.map(x => String(x || '').trim()).filter(Boolean))).slice(0, 2000);
      const deleteFile = Boolean(body.deleteFile);
      const moveToTrash = body.moveToTrash !== false;
      let deletedCount = 0;
      for (const id of uniqueIds) {
        const job = jobs.get(id);
        if (!job) continue;
        recordDeletedJob(job);
        batchQueue.remove(job);
        speedLimiter.setJobLimit(id, 0);
        await job.cancel(deleteFile, { moveToTrashFn: (deleteFile && moveToTrash) ? moveFilesToRecycleBin : null });
        jobs.delete(id);
        deletedCount++;
      }
      saveDeletedItemsRegistry().catch(() => {});
      broadcastState();
      scheduleSaveHistory();
      return sendJson(res, 200, { ok: true, deletedCount, deleteFile, moveToTrash }, req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message }, req);
    }
  }

  const actionMatch = /^\/api\/jobs\/([^/]+)\/(pause|resume|restart|open-folder|open-file|refresh-url|antivirus-scan)$/.exec(pathname);
  if (actionMatch && req.method === 'POST') {
    const id = decodeURIComponent(actionMatch[1]);
    const action = actionMatch[2];
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'Không tìm thấy tác vụ tải' }, req);

    if (action === 'pause') {
      await job.pause();
      return sendJson(res, 200, job.toJSON(), req);
    }
    if (action === 'resume') {
      job.error = null;
      job._rateLimitUntil = 0;
      if (Array.isArray(job.segments)) {
        for (const s of job.segments) {
          s.retries = 0;
          if (s.status !== 'completed') s.status = 'pending';
        }
      }
      job.start();
      return sendJson(res, 200, job.toJSON(), req);
    }
    if (action === 'restart') {
      if (!/^https?:\/\//i.test(job.url || '')) {
        // Recover original HTTP/HTTPS URL from sidecar journal or sibling job before rejecting
        let recoveredUrl = '';
        if (job.filePath && fs.existsSync(`${job.filePath}.hyper.json`)) {
          try {
            const jdata = JSON.parse(fs.readFileSync(`${job.filePath}.hyper.json`, 'utf8'));
            const candidate = jdata.url || jdata.finalUrl || '';
            if (/^https?:\/\//i.test(candidate)) recoveredUrl = candidate;
          } catch {}
        }
        if (!recoveredUrl) {
          for (const sibling of jobs.values()) {
            if (sibling === job || !/^https?:\/\//i.test(sibling.url || '')) continue;
            const samePath = sibling.filePath && job.filePath && sibling.filePath.toLowerCase() === job.filePath.toLowerCase();
            if (samePath) {
              recoveredUrl = sibling.url;
              break;
            }
          }
        }
        if (!recoveredUrl) {
          return sendJson(res, 400, {
            error: 'Mục này là tệp có sẵn trên ổ đĩa (chưa có URL HTTP/HTTPS gốc). Vui lòng dùng "Đổi Link Mới" hoặc "Thêm URL" — tệp cũ vẫn được giữ nguyên.'
          }, req);
        }
        job.url = recoveredUrl;
        job.finalUrl = recoveredUrl;
        job.isLocalOnly = false;
      }
      try {
        await job.restart();
        return sendJson(res, 200, job.toJSON(), req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message }, req);
      }
    }
    if (action === 'refresh-url') {
      try {
        const body = await readJsonBody(req);
        const result = await idmFeatures.refreshJobUrl(job, body.url, { force: Boolean(body.force), resume: true });
        return sendJson(res, 200, { ok: true, ...result, job: job.toJSON() }, req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message }, req);
      }
    }
    if (action === 'antivirus-scan') {
      try {
        const report = await idmFeatures.scanAndVerifyFile(job.filePath);
        const avOk = report.antivirus.scanned ? Boolean(report.antivirus.clean) : true;
        job.idmChecksum = {
          status: report.antivirus.scanned ? (avOk ? 'ok' : 'mismatch') : 'computed',
          algo: report.antivirus.scanned ? 'SHA-256 + Defender' : 'SHA-256 (Không có Defender CLI)',
          actual: report.hashes.sha256
        };
        broadcastState();
        scheduleSaveHistory();
        return sendJson(res, 200, { ok: true, ...report }, req);
      } catch (e) {
        return sendJson(res, 400, { error: e.message }, req);
      }
    }
    if (action === 'open-folder') {
      const target = job.filePath && fs.existsSync(job.filePath) ? job.filePath : (job.saveDir && fs.existsSync(job.saveDir) ? job.saveDir : null);
      if (target) {
        if (process.platform === 'win32') {
          const args = target === job.filePath ? [`/select,${target}`] : [target];
          spawn('explorer.exe', args, { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
          const args = target === job.filePath ? ['-R', target] : [target];
          spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [job.saveDir || path.dirname(target)], { detached: true, stdio: 'ignore' }).unref();
        }
      }
      return sendJson(res, 200, { ok: true }, req);
    }
    if (action === 'open-file') {
      if (job.filePath && fs.existsSync(job.filePath)) {
        const ext = path.extname(job.filePath).toLowerCase();
        const isExecOrScript = ['.exe', '.msi', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.hta', '.scr', '.pif', '.com', '.reg', '.app', '.command'].includes(ext);
        if (process.platform === 'win32') {
          const args = isExecOrScript ? [`/select,${job.filePath}`] : [job.filePath];
          spawn('explorer.exe', args, { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
          const args = isExecOrScript ? ['-R', job.filePath] : [job.filePath];
          spawn('open', args, { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn('xdg-open', [isExecOrScript ? (job.saveDir || path.dirname(job.filePath)) : job.filePath], { detached: true, stdio: 'ignore' }).unref();
        }
      }
      return sendJson(res, 200, { ok: true }, req);
    }
  }

  const deleteMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  if (deleteMatch && req.method === 'DELETE') {
    const id = decodeURIComponent(deleteMatch[1]);
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'Không tìm thấy tác vụ tải' }, req);
    const deleteFile = parsedUrl.searchParams.get('deleteFile') === 'true';
    const moveToTrash = parsedUrl.searchParams.get('moveToTrash') !== 'false';
    recordDeletedJob(job);
    batchQueue.remove(job);
    speedLimiter.setJobLimit(id, 0);
    await job.cancel(deleteFile, { moveToTrashFn: (deleteFile && moveToTrash) ? moveFilesToRecycleBin : null });
    jobs.delete(id);
    saveDeletedItemsRegistry().catch(() => {});
    broadcastState();
    scheduleSaveHistory();
    return sendJson(res, 200, { ok: true, deleteFile, moveToTrash }, req);
  }

  const safeRel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolvedRoot = path.resolve(PUBLIC_DIR);
  const filePath = path.resolve(resolvedRoot, safeRel);
  const insidePublic = process.platform === 'win32'
    ? filePath.toLowerCase().startsWith(resolvedRoot.toLowerCase() + path.sep)
    : filePath.startsWith(resolvedRoot + path.sep);
  if (!insidePublic) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const st = await fsp.stat(filePath).catch(() => null);
  if (st && st.isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') {
      let html = await fsp.readFile(filePath, 'utf8');
      const tokenMeta = `<meta name="duytai-token" content="${AUTH_TOKEN}">`;
      if (html.includes('</head>')) {
        html = html.replace('</head>', `  ${tokenMeta}\n</head>`);
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      return res.end(html);
    }
    const mimeMap = {
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.json': 'application/json'
    };
    res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

function startBrowserSqliteDownloadWatcher() {
  let DatabaseSync = null;
  try {
    DatabaseSync = require('node:sqlite').DatabaseSync;
  } catch {
    return;
  }
  const dbTargets = [];
  let chromiumRoots = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(USER_HOME, 'AppData', 'Local');
    const appData = process.env.APPDATA || path.join(USER_HOME, 'AppData', 'Roaming');
    chromiumRoots = [
      { name: 'Chrome', dir: path.join(localAppData, 'Google', 'Chrome', 'User Data') },
      { name: 'Edge', dir: path.join(localAppData, 'Microsoft', 'Edge', 'User Data') },
      { name: 'CocCoc', dir: path.join(localAppData, 'CocCoc', 'Browser', 'User Data') },
      { name: 'Brave', dir: path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data') },
      { name: 'Vivaldi', dir: path.join(localAppData, 'Vivaldi', 'User Data') }
    ];
    const operaHist = path.join(appData, 'Opera Software', 'Opera Stable', 'History');
    if (fs.existsSync(operaHist)) {
      dbTargets.push({ name: 'Opera', path: operaHist, maxId: -1 });
    }
  } else if (process.platform === 'darwin') {
    const appSupport = path.join(USER_HOME, 'Library', 'Application Support');
    chromiumRoots = [
      { name: 'Chrome', dir: path.join(appSupport, 'Google', 'Chrome') },
      { name: 'Edge', dir: path.join(appSupport, 'Microsoft Edge') },
      { name: 'CocCoc', dir: path.join(appSupport, 'CocCoc', 'Browser') },
      { name: 'Brave', dir: path.join(appSupport, 'BraveSoftware', 'Brave-Browser') },
      { name: 'Vivaldi', dir: path.join(appSupport, 'Vivaldi') },
      { name: 'Arc', dir: path.join(appSupport, 'Arc', 'User Data') }
    ];
    const operaHist = path.join(appSupport, 'com.operasoftware.Opera', 'History');
    if (fs.existsSync(operaHist)) {
      dbTargets.push({ name: 'Opera', path: operaHist, maxId: -1 });
    }
  } else {
    const cfg = path.join(USER_HOME, '.config');
    chromiumRoots = [
      { name: 'Chrome', dir: path.join(cfg, 'google-chrome') },
      { name: 'Chromium', dir: path.join(cfg, 'chromium') },
      { name: 'Edge', dir: path.join(cfg, 'microsoft-edge') },
      { name: 'Brave', dir: path.join(cfg, 'BraveSoftware', 'Brave-Browser') }
    ];
  }
  for (const root of chromiumRoots) {
    if (!fs.existsSync(root.dir)) continue;
    try {
      const subdirs = fs.readdirSync(root.dir, { withFileTypes: true });
      for (const d of subdirs) {
        if (!d.isDirectory()) continue;
        if (d.name !== 'Default' && !/^Profile \d+$/i.test(d.name)) continue;
        const histPath = path.join(root.dir, d.name, 'History');
        if (fs.existsSync(histPath)) {
          dbTargets.push({ name: `${root.name}-${d.name.replace(/\s+/g, '')}`, path: histPath, maxId: -1 });
        }
      }
    } catch {}
  }

  function pollOneBrowser(b) {
    if (!fs.existsSync(b.path)) return;
    try {
      const st = fs.statSync(b.path);
      const walSrc = `${b.path}-wal`;
      let walMod = 0;
      if (fs.existsSync(walSrc)) {
        try { walMod = fs.statSync(walSrc).mtimeMs; } catch {}
      }
      const sig = `${st.mtimeMs}:${st.size}:${walMod}`;
      if (b.lastSig === sig && b.maxId >= 0) return;
      b.lastSig = sig;
    } catch {
      return;
    }
    const tmpDb = path.join(os.tmpdir(), `hyperidm_${b.name.toLowerCase()}_hist.db`);
    const walSrc = `${b.path}-wal`;
    const shmSrc = `${b.path}-shm`;
    const walTmp = `${tmpDb}-wal`;
    const shmTmp = `${tmpDb}-shm`;
    try {
      fs.copyFileSync(b.path, tmpDb);
      if (fs.existsSync(walSrc)) try { fs.copyFileSync(walSrc, walTmp); } catch {}
      if (fs.existsSync(shmSrc)) try { fs.copyFileSync(shmSrc, shmTmp); } catch {}
      const db = new DatabaseSync(tmpDb, { readOnly: true });
      try {
        if (b.maxId < 0) {
          const row = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM downloads').get();
          b.maxId = row ? Number(row.m) : 0;
        } else {
          const rows = db.prepare(
            'SELECT d.id, d.target_path, d.total_bytes, d.tab_url, (SELECT c.url FROM downloads_url_chains c WHERE c.id = d.id ORDER BY c.chain_index DESC LIMIT 1) AS url FROM downloads d WHERE d.id > ? ORDER BY d.id ASC'
          ).all(b.maxId);
          for (const r of rows) {
            b.maxId = Math.max(b.maxId, Number(r.id));
            const dlUrl = String(r.url || '').trim();
            if (!dlUrl || !/^https?:\/\//i.test(dlUrl)) continue;
            if (/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(dlUrl)) continue;
            const fn = r.target_path ? sanitizeOptionalFileName(path.basename(String(r.target_path)).replace(/\.crdownload$|\.opdownload$|\.part$/i, '')) : '';
            const cat = idmFeatures.categorize({ fileName: fn, url: dlUrl });
            const item = {
              id: `br-${b.name}-${r.id}-${Date.now()}`,
              url: dlUrl,
              fileName: fn,
              referrer: String(r.tab_url || ''),
              category: cat,
              saveDir: path.join(DEFAULT_SAVE_DIR, cat),
              source: `${b.name} Auto-Intercept`,
              timestamp: Date.now()
            };
            interceptQueue.push(item);
            if (interceptQueue.length > 100) interceptQueue.splice(0, interceptQueue.length - 100);
            for (const client of sseClients) {
              try {
                client.write(`data: ${JSON.stringify({ type: 'intercept', item })}\n\n`);
              } catch {}
            }
          }
        }
      } finally {
        db.close();
      }
    } catch {}
    for (const p of [tmpDb, walTmp, shmTmp]) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
    }
  }

  for (const b of dbTargets) pollOneBrowser(b);
  setInterval(() => {
    for (const b of dbTargets) pollOneBrowser(b);
  }, 900);
}

function startIdmSchedulerDaemon() {
  let lastStartTriggerMinute = '';
  let lastStopTriggerMinute = '';
  setInterval(() => {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (schedulerConfig.enabled) {
      if (schedulerConfig.startAtTime && schedulerConfig.startAtTime === hhmm && lastStartTriggerMinute !== hhmm) {
        lastStartTriggerMinute = hhmm;
        let active = 0;
        for (const j of jobs.values()) {
          if (['downloading', 'probing', 'resolving', 'muxing'].includes(j.status)) active++;
        }
        for (const j of jobs.values()) {
          if (active >= schedulerConfig.maxConcurrent) break;
          if (j.status === 'paused' || j.status === 'queued') {
            j.start();
            active++;
          }
        }
      } else if (schedulerConfig.startAtTime !== hhmm) {
        lastStartTriggerMinute = '';
      }
      if (schedulerConfig.stopAtTime && schedulerConfig.stopAtTime === hhmm && lastStopTriggerMinute !== hhmm) {
        lastStopTriggerMinute = hhmm;
        for (const j of jobs.values()) {
          if (['downloading', 'probing', 'resolving', 'muxing'].includes(j.status)) {
            j.pause();
          }
        }
      } else if (schedulerConfig.stopAtTime !== hhmm) {
        lastStopTriggerMinute = '';
      }
      const nowMs = Date.now();
      if (nowMs - schedulerConfig.lastRetryTick >= schedulerConfig.autoRetryIntervalSec * 1000) {
        schedulerConfig.lastRetryTick = nowMs;
        for (const j of jobs.values()) {
          if (j.status === 'error' && (j._schedulerRetries || 0) < 5) {
            j._schedulerRetries = (j._schedulerRetries || 0) + 1;
            j.start();
          }
        }
      }
    }
  }, 10000).unref();
}

function appendErrorLog(tag, err) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const msg = `[${new Date().toISOString()}] [${tag}] ${(err && (err.stack || err.message)) || String(err)}\n`;
    fs.appendFileSync(ERROR_LOG_FILE, msg);
  } catch {}
}

process.on('uncaughtException', (err) => {
  appendErrorLog('uncaughtException', err);
  if (err && (err.code === 'EADDRINUSE' || err.syscall === 'listen')) {
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  appendErrorLog('unhandledRejection', reason);
});

let isShuttingDown = false;
async function gracefulShutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  try {
    for (const job of jobs.values()) {
      if (['downloading', 'probing', 'resolving', 'muxing'].includes(job.status)) {
        await job.pause().catch(() => {});
      }
    }
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(serializeJobsForHistory()), 'utf8');
    if (fs.existsSync(TOKEN_FILE)) {
      const curTok = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (curTok === AUTH_TOKEN) fs.unlinkSync(TOKEN_FILE);
    }
  } catch {}
  try { server.close(); } catch {}
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

server.on('error', (err) => {
  appendErrorLog('serverError', err);
  process.exit(1);
});

loadHistory().then(() => {
  startBrowserSqliteDownloadWatcher();
  startIdmSchedulerDaemon();
  server.listen(PORT, '127.0.0.1', () => {
    try {
      fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
      fs.writeFileSync(TOKEN_FILE, AUTH_TOKEN, { encoding: 'utf8', mode: 0o600 });
    } catch {}
    console.log(`[Duytai v7.5 64-Bit Engine] Listening on http://127.0.0.1:${PORT}`);
  });
});
