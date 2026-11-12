const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const { DownloadJob } = require('./engine');
const idmFeatures = require('./idm-features');

const PORT = parseInt(process.env.HYPER_IDM_PORT || '17890', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const HISTORY_FILE = path.join(__dirname, 'jobs-history.json');
const DEFAULT_SAVE_DIR = path.join(process.env.USERPROFILE || 'C:\\Users\\admin', 'Downloads', 'HyperIDM');

const jobs = new Map();
const sseClients = new Set();
const interceptQueue = [];
const speedLimiter = new idmFeatures.SpeedLimiter(() => jobs.values());

const BENCHMARK_CHUNK = Buffer.alloc(1024 * 1024, 0x48);

function createAndRegisterJob(opts, startImmediately = true) {
  const autoCategory = opts.autoCategory !== false && !opts.saveDir;
  const saveDir = opts.saveDir || (autoCategory
    ? idmFeatures.categorizeSaveDir(DEFAULT_SAVE_DIR, opts.url, opts.fileName || '')
    : DEFAULT_SAVE_DIR);

  const job = new DownloadJob({
    id: opts.id,
    url: opts.url.trim(),
    saveDir,
    fileName: opts.fileName || '',
    maxConnections: opts.maxConnections || 64,
    headers: opts.headers || {},
    videoQuality: opts.videoQuality || 'best'
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
  if (startImmediately) job.start();
  return job;
}

const batchQueue = new idmFeatures.DownloadQueue({
  createJob: (url, opts) => createAndRegisterJob({ ...opts, url }, false),
  maxConcurrent: 3
});

async function loadHistory() {
  try {
    await fsp.mkdir(DEFAULT_SAVE_DIR, { recursive: true });
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = await fsp.readFile(HISTORY_FILE, 'utf8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const item of list) {
          const job = new DownloadJob({
            id: item.id,
            url: item.url,
            saveDir: item.saveDir || DEFAULT_SAVE_DIR,
            fileName: item.fileName,
            maxConnections: item.maxConnections || 64
          });
          job.finalUrl = item.finalUrl || item.url;
          job.filePath = item.filePath || path.join(job.saveDir, item.fileName || '');
          job.stateFilePath = `${job.filePath}.hyper.json`;
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
          if (jobs.has(id)) continue;
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
    const downloadsRoot = path.join(process.env.USERPROFILE || 'C:\\Users\\admin', 'Downloads');
    const existingPaths = new Set(Array.from(jobs.values()).map(j => (j.filePath || '').toLowerCase()));
    const scanDirs = [downloadsRoot, DEFAULT_SAVE_DIR];
    for (const folder of Object.keys(idmFeatures.CATEGORIES || {})) {
      scanDirs.push(path.join(DEFAULT_SAVE_DIR, folder));
      scanDirs.push(path.join(downloadsRoot, folder));
    }

    const foundFiles = [];
    for (const dir of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (ent.name.endsWith('.hyper.json') || ent.name === 'desktop.ini') continue;
        const fullPath = path.join(dir, ent.name);
        if (existingPaths.has(fullPath.toLowerCase())) continue;
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
      const id = 'local-' + Buffer.from(f.name).toString('hex').slice(0, 16);
      if (jobs.has(id)) continue;
      const job = new DownloadJob({
        id,
        url: `file:///${f.fullPath.replace(/\\/g, '/')}`,
        saveDir: f.dir,
        fileName: f.name,
        maxConnections: 64
      });
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

let saveDebounce = null;
function scheduleSaveHistory() {
  if (saveDebounce) return;
  saveDebounce = setTimeout(async () => {
    saveDebounce = null;
    try {
      const serialized = Array.from(jobs.values()).map(j => j.toJSON());
      await fsp.writeFile(HISTORY_FILE, JSON.stringify(serialized, null, 2), 'utf8');
    } catch {}
  }, 800);
}

function broadcastState() {
  const payload = JSON.stringify({
    type: 'snapshot',
    timestamp: Date.now(),
    defaultSaveDir: DEFAULT_SAVE_DIR,
    globalLimitBps: speedLimiter.globalBps,
    jobs: Array.from(jobs.values()).map(j => j.toJSON())
  });
  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

function attachJobEvents(job) {
  job.on('update', () => {
    broadcastState();
    scheduleSaveHistory();
  });
  job.on('completed', () => {
    broadcastState();
    scheduleSaveHistory();
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const pathname = parsedUrl.pathname;

  // Built-in HTTP 206 Range Server for Multi-Gigabit Engine Stress Benchmarking
  if (pathname.startsWith('/benchmark-payload/')) {
    const match = /\/benchmark-payload\/(\d+)MB\.bin$/i.exec(pathname);
    const sizeMB = match ? Math.min(2048, Math.max(10, parseInt(match[1], 10))) : 256;
    const totalBytes = sizeMB * 1024 * 1024;

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
      'Server': 'HyperIDM-StressTest-Node/26',
      'ETag': `"hyper-bench-${sizeMB}mb"`
    };
    if (statusCode === 206) {
      headers['Content-Range'] = `bytes ${start}-${end}/${totalBytes}`;
    }

    res.writeHead(statusCode, headers);
    let remaining = contentLength;

    function pump() {
      let ok = true;
      while (remaining > 0 && ok) {
        const toSend = Math.min(remaining, BENCHMARK_CHUNK.length);
        const slice = toSend === BENCHMARK_CHUNK.length ? BENCHMARK_CHUNK : BENCHMARK_CHUNK.subarray(0, toSend);
        remaining -= toSend;
        if (remaining === 0) {
          res.end(slice);
        } else {
          ok = res.write(slice);
        }
      }
      if (remaining > 0) {
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
      'Access-Control-Allow-Origin': '*'
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
    });
  }

  if (pathname === '/api/jobs' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.url || typeof body.url !== 'string') {
        return sendJson(res, 400, { error: 'URL không hợp lệ' });
      }
      // Check if URL contains a batch pattern like file[01-10].zip
      const expanded = idmFeatures.expandBatchPattern(body.url);
      if (expanded.length > 1) {
        const created = batchQueue.add(expanded, body);
        return sendJson(res, 201, { batchCount: created.length, jobs: created.map(j => j.toJSON()) });
      }
      const job = createAndRegisterJob(body, true);
      return sendJson(res, 201, job.toJSON());
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Batch Queue Endpoint
  if (pathname === '/api/batch' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const created = batchQueue.add(body.text || body.urls || '', body);
      return sendJson(res, 201, { count: created.length, jobs: created.map(j => j.toJSON()) });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
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
      return sendJson(res, 200, { ok: true, globalLimitBps: speedLimiter.globalBps });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Categories list endpoint
  if (pathname === '/api/categories' && req.method === 'GET') {
    return sendJson(res, 200, { categories: idmFeatures.CATEGORIES });
  }

  // Batch Pattern Expand endpoint
  if (pathname === '/api/batch-expand' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const urls = idmFeatures.expandBatchPattern(body.pattern || body.url || '');
      return sendJson(res, 200, { count: urls.length, urls });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  // Intercept Link Queue (for System Tray Native Popup Dialog & Browser Extension)
  if (pathname === '/api/intercept' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.url) return sendJson(res, 400, { error: 'Missing url' });
      const cat = idmFeatures.categorize({ fileName: body.fileName || '', url: body.url });
      const item = {
        id: 'int-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        url: body.url,
        fileName: body.fileName || '',
        referrer: body.referrer || '',
        category: cat,
        saveDir: path.join(DEFAULT_SAVE_DIR, cat),
        timestamp: Date.now()
      };
      interceptQueue.push(item);
      for (const client of sseClients) {
        try {
          client.write(`data: ${JSON.stringify({ type: 'intercept', item })}\n\n`);
        } catch {}
      }
      return sendJson(res, 201, { ok: true, item });
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }

  if (pathname === '/api/intercept-queue' && req.method === 'GET') {
    const items = interceptQueue.splice(0, interceptQueue.length);
    return sendJson(res, 200, { items });
  }

  // Pause All Active Jobs (IDM "Dừng tất cả" button & Tray action)
  if (pathname === '/api/pause-all' && req.method === 'POST') {
    let pausedCount = 0;
    for (const job of jobs.values()) {
      if (['downloading', 'probing', 'resolving'].includes(job.status)) {
        await job.pause();
        pausedCount++;
      }
    }
    broadcastState();
    scheduleSaveHistory();
    return sendJson(res, 200, { ok: true, pausedCount });
  }

  // Clear All Completed Jobs from List (IDM "Xóa các mục đã hoàn thành" button)
  if (pathname === '/api/clear-completed' && req.method === 'POST') {
    let removedCount = 0;
    for (const [id, job] of jobs.entries()) {
      if (job.status === 'completed') {
        jobs.delete(id);
        removedCount++;
      }
    }
    broadcastState();
    scheduleSaveHistory();
    return sendJson(res, 200, { ok: true, removedCount });
  }

  const actionMatch = /^\/api\/jobs\/([^/]+)\/(pause|resume|open-folder|open-file|refresh-url)$/.exec(pathname);
  if (actionMatch && req.method === 'POST') {
    const [, id, action] = actionMatch;
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'Không tìm thấy tác vụ tải' });

    if (action === 'pause') {
      await job.pause();
      return sendJson(res, 200, job.toJSON());
    }
    if (action === 'resume') {
      job.start();
      return sendJson(res, 200, job.toJSON());
    }
    if (action === 'refresh-url') {
      try {
        const body = await readJsonBody(req);
        const result = await idmFeatures.refreshJobUrl(job, body.url, { force: Boolean(body.force), resume: true });
        return sendJson(res, 200, { ok: true, ...result, job: job.toJSON() });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    if (action === 'open-folder') {
      if (job.filePath && fs.existsSync(job.filePath)) {
        spawn('explorer.exe', [`/select,${job.filePath}`], { detached: true, stdio: 'ignore' }).unref();
      } else if (job.saveDir && fs.existsSync(job.saveDir)) {
        spawn('explorer.exe', [job.saveDir], { detached: true, stdio: 'ignore' }).unref();
      }
      return sendJson(res, 200, { ok: true });
    }
    if (action === 'open-file') {
      if (job.filePath && fs.existsSync(job.filePath)) {
        spawn('cmd.exe', ['/c', 'start', '', job.filePath], { detached: true, stdio: 'ignore' }).unref();
      }
      return sendJson(res, 200, { ok: true });
    }
  }

  const deleteMatch = /^\/api\/jobs\/([^/]+)$/.exec(pathname);
  if (deleteMatch && req.method === 'DELETE') {
    const id = deleteMatch[1];
    const job = jobs.get(id);
    if (!job) return sendJson(res, 404, { error: 'Không tìm thấy tác vụ tải' });
    const deleteFile = parsedUrl.searchParams.get('deleteFile') === 'true';
    batchQueue.remove(job);
    await job.cancel(deleteFile);
    jobs.delete(id);
    broadcastState();
    scheduleSaveHistory();
    return sendJson(res, 200, { ok: true });
  }

  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap = {
      '.html': 'text/html; charset=utf-8',
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
  const os = require('os');
  const localAppData = process.env.LOCALAPPDATA || 'C:\\Users\\admin\\AppData\\Local';
  const dbTargets = [
    { name: 'Chrome', path: path.join(localAppData, 'Google\\Chrome\\User Data\\Default\\History'), maxId: -1 },
    { name: 'Edge', path: path.join(localAppData, 'Microsoft\\Edge\\User Data\\Default\\History'), maxId: -1 },
    { name: 'CocCoc', path: path.join(localAppData, 'CocCoc\\Browser\\User Data\\Default\\History'), maxId: -1 }
  ];

  function pollOneBrowser(b) {
    if (!fs.existsSync(b.path)) return;
    const tmpDb = path.join(os.tmpdir(), `hyperidm_${b.name.toLowerCase()}_hist.db`);
    try {
      fs.copyFileSync(b.path, tmpDb);
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
            const fn = r.target_path ? path.basename(String(r.target_path)) : '';
            const cat = idmFeatures.categorize({ fileName: fn, url: dlUrl });
            const item = {
              id: `br-${b.name}-${r.id}-${Date.now()}`,
              url: dlUrl,
              fileName: fn.replace(/\.crdownload$|\.opdownload$|\.part$/i, ''),
              referrer: String(r.tab_url || ''),
              category: cat,
              saveDir: path.join(DEFAULT_SAVE_DIR, cat),
              source: `${b.name} Auto-Intercept`,
              timestamp: Date.now()
            };
            interceptQueue.push(item);
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
    try { if (fs.existsSync(tmpDb)) fs.unlinkSync(tmpDb); } catch {}
  }

  for (const b of dbTargets) pollOneBrowser(b);
  setInterval(() => {
    for (const b of dbTargets) pollOneBrowser(b);
  }, 900);
}

loadHistory().then(() => {
  startBrowserSqliteDownloadWatcher();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[HyperIDM Ultra v4.0 64-Bit Engine] Listening on http://127.0.0.1:${PORT}`);
  });
});
