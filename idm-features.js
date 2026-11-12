'use strict';
/**
 * HyperIDM Ultra — IDM-parity+ feature pack (non-invasive: does NOT modify engine.js / server.js).
 *
 *  1. Auto-Category Folder Sorting   categorize(), categorizeSaveDir(), relocateToCategory()
 *  2. Checksum Verifier              hashFile(), ProgressiveHasher (hashes the contiguous completed prefix
 *                                    WHILE downloading, so at 100% only the tail is left), lookupIpswHashes()
 *  3. Expired Link Refresh           refreshJobUrl(), watchExpiredLink() — swaps CDN token URL, keeps .hyper.json
 *  4. Batch URL Queue                expandBatchPattern(), DownloadQueue
 *  5. Speed Limiter                  SpeedLimiter (global + per-job token bucket via socket backpressure)
 *  attachIdmFeatures(job, opts)      one-call wiring for server.js
 *
 * Engine contract used (read-only unless noted): job.status/segments/activeWorkers/filePath/saveDir/fileName/
 * finalUrl/url/resolverType/expectedSha1/totalBytes/etag/lastModified/downloadedBytes, job._probeUrl(),
 * job._resolveIpswMeUrl(), job._saveStateJournal(), job.pause()/start(), events 'update' / 'completed'.
 * Writes: job.finalUrl/url (refresh), seg.retries (refresh), seg.lastDataTime/slowTicks (limiter, so the
 * engine's 2.2s stall watchdog does not recycle sockets we paused on purpose).
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ───────────────────────── 1. Auto-Category ─────────────────────────
const CATEGORIES = {
  Compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'lz', 'lzma', 'cab', 'arj', 'z', 'sitx'],
  Programs: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'apk', 'apks', 'xapk', 'aab', 'deb', 'rpm', 'pkg', 'appimage', 'bat', 'cmd', 'ps1', 'jar', 'msu', 'snap', 'flatpak'],
  Video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'vob', 'ogv', 'rmvb'],
  Music: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'alac', 'aiff', 'ape', 'mid', 'midi'],
  Documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'rtf', 'csv', 'epub', 'mobi', 'azw3', 'md', 'chm', 'djvu', 'xps'],
  Firmware_ISO: ['ipsw', 'iso', 'img', 'dmg', 'bin', 'vhd', 'vhdx', 'vmdk', 'qcow2', 'wim', 'esd', 'swm', 'ova', 'ovf', 'hex', 'uf2', 'fw', 'tar.md5', 'ffu', 'ota']
};
const EXT_TO_CATEGORY = new Map();
for (const [cat, exts] of Object.entries(CATEGORIES)) for (const e of exts) EXT_TO_CATEGORY.set(e, cat);

const MIME_PREFIX = [
  [/^video\//, 'Video'], [/^audio\//, 'Music'],
  [/(zip|rar|7z|x-tar|gzip|bzip|xz|zstd|compressed)/, 'Compressed'],
  [/(msdownload|msi|android\.package|x-apple-diskimage|debian|x-rpm|x-executable)/, 'Programs'],
  [/(pdf|msword|officedocument|opendocument|epub|^text\/)/, 'Documents'],
  [/(iso9660|x-raw-disk|ipsw)/, 'Firmware_ISO']
];

/** Smarter than IDM: compound extensions (.tar.gz, .tar.md5), URL-host hints, MIME fallback. */
function categorize({ fileName = '', url = '', mimeType = '' } = {}) {
  const name = String(fileName).toLowerCase();
  const m2 = /\.([a-z0-9]+\.[a-z0-9]+)$/.exec(name);
  if (m2 && EXT_TO_CATEGORY.has(m2[1])) return EXT_TO_CATEGORY.get(m2[1]);
  if (/\.tar\.[a-z0-9]+$/.test(name)) return 'Compressed';
  const ext = path.extname(name).slice(1);
  if (ext && EXT_TO_CATEGORY.has(ext)) {
    // .dmg on macOS is mostly an installer; keep under Programs unless it is an Apple restore image.
    if (ext === 'dmg' && !/restore|firmware|ipsw/i.test(name + url)) return 'Programs';
    return EXT_TO_CATEGORY.get(ext);
  }
  const u = String(url);
  if (/ipsw\.me\/|updates\.cdn-apple\.com\/.*\.ipsw/i.test(u)) return 'Firmware_ISO';
  if (/(youtube\.com\/(watch|shorts)|youtu\.be\/|googlevideo\.com)/i.test(u)) return 'Video';
  if (!ext && u) {
    try {
      const fromUrl = categorize({ fileName: decodeURIComponent(path.posix.basename(new URL(u).pathname)) });
      if (fromUrl !== 'General') return fromUrl;
    } catch {}
  }
  const mime = String(mimeType).toLowerCase();
  if (mime && mime !== 'application/octet-stream') {
    for (const [re, cat] of MIME_PREFIX) if (re.test(mime)) return cat;
  }
  return 'General';
}

/** Pre-start: pick the category sub-folder from URL/fileName (server.js POST /api/jobs). */
function categorizeSaveDir(baseDir, url, fileName = '') {
  return path.join(baseDir, categorize({ fileName, url }));
}

async function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
  for (let i = 1; i < 1000; i++) {
    const c = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(c)) return c;
  }
  return path.join(dir, `${base}_${Date.now()}${ext}`);
}

/**
 * Post-complete fallback: once the real file name / MIME is known, move the file into
 * <baseDir>/<Category>/ if it currently sits in baseDir or a different category folder under baseDir.
 * Same volume => fs.rename is an O(1) metadata move. Cross-volume falls back to copy+unlink.
 */
async function relocateToCategory(job, baseDir) {
  if (!job.filePath || !fs.existsSync(job.filePath)) return null;
  const category = categorize({ fileName: job.fileName || path.basename(job.filePath), url: job.url, mimeType: job.mimeType });
  const curDir = path.resolve(path.dirname(job.filePath));
  const base = path.resolve(baseDir);
  const targetDir = path.join(base, category);
  const known = [...Object.keys(CATEGORIES), 'General'];
  const managed = curDir === base || (path.dirname(curDir) === base && known.includes(path.basename(curDir)));
  if (!managed || curDir === targetDir) return category;
  await fsp.mkdir(targetDir, { recursive: true });
  const dest = await uniquePath(path.join(targetDir, path.basename(job.filePath)));
  try {
    await fsp.rename(job.filePath, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await fsp.copyFile(job.filePath, dest);
    await fsp.unlink(job.filePath);
  }
  job.filePath = dest;
  job.fileName = path.basename(dest);
  job.saveDir = targetDir;
  job.stateFilePath = `${dest}.hyper.json`;
  return category;
}

// ───────────────────────── 2. Checksum Verifier ─────────────────────────
const HASH_READ_CHUNK = 4 * 1024 * 1024;
const ALGO_BY_HEXLEN = { 32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512' };

function detectAlgo(hex) {
  const h = String(hex || '').trim().toLowerCase();
  return /^[0-9a-f]+$/.test(h) ? (ALGO_BY_HEXLEN[h.length] || null) : null;
}

/** Stream-hash [start, end) of a file with several algorithms in ONE disk pass (4 MB reads). */
async function hashFile(filePath, algos = ['sha256'], { start = 0, end, hashers, onProgress } = {}) {
  const hs = hashers || Object.fromEntries(algos.map(a => [a, crypto.createHash(a)]));
  const stream = fs.createReadStream(filePath, { start, end: end != null ? end - 1 : undefined, highWaterMark: HASH_READ_CHUNK });
  let done = 0;
  for await (const chunk of stream) {
    for (const h of Object.values(hs)) h.update(chunk);
    done += chunk.length;
    if (onProgress) onProgress(done);
  }
  if (hashers) return done;
  return Object.fromEntries(Object.entries(hs).map(([a, h]) => [a, h.digest('hex')]));
}

/**
 * Hashes the contiguous prefix of COMPLETED segments while the download is running.
 * Only 'completed' segments are trusted: the engine marks a segment completed after its
 * write buffer is flushed, so those bytes are on disk. At 100% only the remainder is read.
 */
class ProgressiveHasher {
  constructor(job, algo) {
    this.job = job;
    this.algo = algo;
    this.hash = crypto.createHash(algo);
    this.offset = 0;
    this._busy = null;
    this._timer = null;
  }

  _completedPrefix() {
    const segs = this.job.segments.filter(s => s.status === 'completed' && s.end >= s.start).sort((a, b) => a.start - b.start);
    let cursor = 0;
    for (const s of segs) {
      if (s.start > cursor) break;
      cursor = Math.max(cursor, s.end + 1);
    }
    return cursor;
  }

  start(intervalMs = 1000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.pump().catch(() => {}); }, intervalMs);
    this._timer.unref?.();
  }

  stop() { clearInterval(this._timer); this._timer = null; }

  pump(limit) {
    if (this._busy) return this._busy;
    const target = limit != null ? limit : this._completedPrefix();
    if (target <= this.offset || !this.job.filePath || !fs.existsSync(this.job.filePath)) return Promise.resolve();
    this._busy = hashFile(this.job.filePath, null, { start: this.offset, end: target, hashers: { [this.algo]: this.hash } })
      .then(n => { this.offset += n; })
      .finally(() => { this._busy = null; });
    return this._busy;
  }

  /** Called after 'completed': hash the remainder and return hex digest. */
  async finalize(totalBytes) {
    this.stop();
    if (this._busy) await this._busy.catch(() => {});
    if (this.offset > 0 && this._completedPrefix() < this.offset) {
      this.hash = crypto.createHash(this.algo); // segments were re-initialized: restart cleanly
      this.offset = 0;
    }
    await this.pump(totalBytes);
    return this.hash.digest('hex');
  }
}

function fetchJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'HyperIDM-Ultra' }, timeout: timeoutMs }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('ipsw.me API timeout')));
    req.on('error', reject);
  });
}

/**
 * Get {sha256, sha1, md5, filesize} for an Apple firmware.
 * - ipsw.me page URL  -> /v4/ipsw/{identifier}/{build}
 * - direct Apple CDN *.ipsw (e.g. UniversalMac_15.5_24F74_Restore.ipsw) -> /v4/ipsw/{version}, matched by URL/basename.
 */
async function lookupIpswHashes(pageUrl, cdnUrl) {
  const pick = d => d && { sha256: d.sha256sum || '', sha1: d.sha1sum || '', md5: d.md5sum || '', filesize: d.filesize || 0 };
  const page = /^https?:\/\/(?:www\.)?ipsw\.me\/download\/([^/]+)\/([^/?#]+)/i.exec(pageUrl || '');
  if (page) return pick(await fetchJson(`https://api.ipsw.me/v4/ipsw/${encodeURIComponent(page[1])}/${encodeURIComponent(page[2])}`));
  if (!cdnUrl) return null;
  let base;
  try { base = path.posix.basename(new URL(cdnUrl).pathname); } catch { return null; }
  const m = /_(\d+(?:\.\d+)+)_([0-9A-Z]+[a-z]?)_Restore\.ipsw$/i.exec(base);
  if (!m) return null;
  const list = await fetchJson(`https://api.ipsw.me/v4/ipsw/${encodeURIComponent(m[1])}`);
  const strip = u => String(u).split('?')[0];
  const hit = Array.isArray(list) && (list.find(f => strip(f.url) === strip(cdnUrl)) || list.find(f => f.buildid === m[2] && path.posix.basename(strip(f.url)) === base));
  return pick(hit) || null;
}

/** Choose strongest available expected hash: explicit > sha256 > sha1 > md5. */
function pickExpected({ expectedHash, ipsw, engineSha1 }) {
  if (expectedHash) {
    const algo = detectAlgo(expectedHash);
    if (algo) return { algo, hex: expectedHash.trim().toLowerCase(), source: 'user' };
  }
  if (ipsw?.sha256) return { algo: 'sha256', hex: ipsw.sha256.toLowerCase(), source: 'ipsw.me' };
  if (ipsw?.sha1) return { algo: 'sha1', hex: ipsw.sha1.toLowerCase(), source: 'ipsw.me' };
  if (engineSha1) return { algo: 'sha1', hex: engineSha1.toLowerCase(), source: 'ipsw.me' };
  if (ipsw?.md5) return { algo: 'md5', hex: ipsw.md5.toLowerCase(), source: 'ipsw.me' };
  return null;
}

// ───────────────────────── 3. Expired Link Refresh ─────────────────────────
const EXPIRED_RE = /HTTP (401|403|404|410)\b/;

/**
 * IDM "Refresh download address", but safe: probes the new URL and refuses it unless the size matches
 * (and ETag/Last-Modified, when both servers send them). Segments, sparse file and .hyper.json are kept;
 * only finalUrl changes and per-segment retry counters are reset. Resumes if it was running or errored.
 */
async function refreshJobUrl(job, newUrl, { force = false, resume = true } = {}) {
  if (!/^https?:\/\//i.test(newUrl || '')) throw new Error('URL mới không hợp lệ');
  const meta = await job._probeUrl(newUrl);
  if (job.totalBytes > 0 && meta.totalBytes !== job.totalBytes) {
    throw new Error(`Kích thước không khớp (cũ ${job.totalBytes} B, mới ${meta.totalBytes} B) — từ chối để bảo vệ dữ liệu đã tải`);
  }
  if (!force) {
    const etagDiff = job.etag && meta.etag && job.etag.replace(/^W\//, '') !== meta.etag.replace(/^W\//, '');
    const lmDiff = job.lastModified && meta.lastModified && job.lastModified !== meta.lastModified;
    if (etagDiff && lmDiff) throw new Error('ETag và Last-Modified đều khác — nội dung đã thay đổi (dùng force để bỏ qua)');
  }
  if (job.totalBytes > 0 && !meta.acceptRanges) throw new Error('Link mới không hỗ trợ Range — không thể tải tiếp');

  const wasRunning = job.status === 'downloading' || job.status === 'probing';
  const wasError = job.status === 'error';
  if (wasRunning) await job.pause();

  job.finalUrl = meta.finalUrl;
  if (job.resolverType !== 'ipsw') job.url = newUrl; // ipsw.me page link stays the canonical source
  if (meta.etag) job.etag = meta.etag;
  if (meta.lastModified) job.lastModified = meta.lastModified;
  for (const s of job.segments) { s.retries = 0; if (s.status === 'downloading') s.status = 'pending'; }
  job.error = null;
  if (wasError) job.status = 'paused';
  await job._saveStateJournal();
  job.emit('update', job.toJSON());
  if (resume && (wasRunning || wasError)) job.start();
  return { finalUrl: job.finalUrl, totalBytes: meta.totalBytes };
}

/**
 * Detects token-expired CDN links (401/403/404/410 after engine retries).
 * ipsw.me jobs auto-refresh by re-resolving the API; others use opts.resolveFreshUrl(job) if given,
 * otherwise job.linkExpired=true is exposed to the UI and 'link-expired' is emitted.
 */
function watchExpiredLink(job, { resolveFreshUrl, maxAuto = 3 } = {}) {
  let attempts = 0, busy = false;
  const onUpdate = async () => {
    if (busy || job.status !== 'error' || !EXPIRED_RE.test(job.error || '')) return;
    busy = true;
    try {
      let fresh = null;
      if (attempts < maxAuto) {
        if (job.resolverType === 'ipsw') fresh = (await job._resolveIpswMeUrl(job.url)).url;
        else if (resolveFreshUrl) fresh = await resolveFreshUrl(job);
      }
      if (fresh) {
        attempts++;
        await refreshJobUrl(job, fresh);
        job.linkExpired = false;
      } else {
        job.linkExpired = true;
        job.emit('link-expired', job.toJSON());
        job.emit('update', job.toJSON());
      }
    } catch (e) {
      job.linkExpired = true;
      job.error = `${job.error} | Refresh thất bại: ${e.message}`;
      job.emit('update', job.toJSON());
    } finally {
      busy = false;
    }
  };
  job.on('update', onUpdate);
  return () => job.off('update', onUpdate);
}

// ───────────────────────── 4. Batch URL Queue ─────────────────────────
const MAX_BATCH = 10000;

/**
 * IDM "Add batch download": expands file[001-120].zip, img[a-f].jpg, multi-line text; dedupes.
 * Zero padding follows the width of the start token.
 */
function expandBatchPattern(text) {
  const out = new Set();
  const expand = (s) => {
    if (out.size >= MAX_BATCH) return;
    const m = /\[(\d+)-(\d+)(?::(\d+))?\]|\[([a-zA-Z])-([a-zA-Z])\]/.exec(s);
    if (!m) { out.add(s); return; }
    const head = s.slice(0, m.index), tail = s.slice(m.index + m[0].length);
    if (m[1] != null) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10), step = Math.max(1, parseInt(m[3] || '1', 10));
      const width = m[1].length > 1 && m[1].startsWith('0') ? m[1].length : 0;
      const dir = a <= b ? 1 : -1;
      for (let i = a; dir > 0 ? i <= b : i >= b; i += step * dir) {
        expand(head + (width ? String(i).padStart(width, '0') : String(i)) + tail);
        if (out.size >= MAX_BATCH) return;
      }
    } else {
      const a = m[4].charCodeAt(0), b = m[5].charCodeAt(0), dir = a <= b ? 1 : -1;
      for (let c = a; dir > 0 ? c <= b : c >= b; c += dir) expand(head + String.fromCharCode(c) + tail);
    }
  };
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (/^https?:\/\//i.test(t)) expand(t);
  }
  return [...out];
}

/**
 * FIFO queue with N concurrent downloads (IDM "Main queue").
 * createJob(url, opts) must build + register a DownloadJob (server: new DownloadJob, attachJobEvents, jobs.set)
 * WITHOUT calling start(); the queue starts it when a slot frees.
 */
class DownloadQueue {
  constructor({ createJob, maxConcurrent = 3 }) {
    if (typeof createJob !== 'function') throw new Error('createJob required');
    this.createJob = createJob;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.pending = [];
    this.active = new Set();
  }

  add(urlsOrText, opts = {}) {
    const urls = Array.isArray(urlsOrText) ? urlsOrText : expandBatchPattern(urlsOrText);
    const jobs = urls.map(u => this.createJob(u, opts));
    this.pending.push(...jobs);
    this._drain();
    return jobs;
  }

  setMaxConcurrent(n) { this.maxConcurrent = Math.max(1, n | 0); this._drain(); }

  remove(job) {
    this.pending = this.pending.filter(j => j !== job);
    this.active.delete(job);
    this._drain();
  }

  _drain() {
    while (this.active.size < this.maxConcurrent && this.pending.length) {
      const job = this.pending.shift();
      if (job.status !== 'queued' && job.status !== 'paused') continue;
      this.active.add(job);
      const onUpdate = () => {
        if (['completed', 'error', 'canceled', 'paused'].includes(job.status)) {
          job.off('update', onUpdate);
          this.active.delete(job);
          this._drain();
        }
      };
      job.on('update', onUpdate);
      job.start();
    }
  }
}

// ───────────────────────── 5. Speed Limiter ─────────────────────────
/**
 * Token bucket over job.downloadedBytes, enforced by pausing worker sockets (TCP backpressure; the
 * server slows down, no data is dropped). Debt is capped at 5 s of budget so a paused response never
 * reaches the engine's 12 s socket timeout (accurate while line rate < ~100x the limit); seg.lastDataTime/slowTicks are refreshed for held
 * segments so the 2.2 s stall watchdog does not recycle them. YouTube dual-track jobs are not
 * limited (their sockets live in private sub-jobs).
 */
class SpeedLimiter {
  constructor(getJobs, { tickMs = 50 } = {}) {
    this.getJobs = getJobs;
    this.tickMs = tickMs;
    this.globalBps = 0;
    this.jobBps = new Map(); // jobId -> bps
    this._state = new Map(); // bucketKey -> {debt, last: Map(jobId->bytes)}
    this._paused = new Map(); // socket -> job
    this._timer = null;
    this._lastTick = Date.now();
  }

  setGlobalLimit(bps) { this.globalBps = Math.max(0, bps | 0); this._ensure(); }

  setJobLimit(jobId, bps) {
    if (bps > 0) this.jobBps.set(jobId, bps | 0); else { this.jobBps.delete(jobId); this._state.delete(`job:${jobId}`); }
    this._ensure();
  }

  _ensure() {
    const needed = this.globalBps > 0 || this.jobBps.size > 0;
    if (needed && !this._timer) {
      this._lastTick = Date.now();
      this._timer = setInterval(() => this._tick(), this.tickMs);
      this._timer.unref?.();
    } else if (!needed && this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      this._resumeAll();
      this._state.clear();
    }
  }

  stop() { this.globalBps = 0; this.jobBps.clear(); this._ensure(); }

  _bucketOver(key, jobs, bps, dt) {
    let st = this._state.get(key);
    if (!st) { st = { debt: 0, last: new Map() }; this._state.set(key, st); }
    let delta = 0;
    for (const j of jobs) {
      const prev = st.last.has(j.id) ? st.last.get(j.id) : j.downloadedBytes;
      delta += Math.max(0, j.downloadedBytes - prev);
      st.last.set(j.id, j.downloadedBytes);
    }
    st.debt += delta - bps * dt;
    st.debt = Math.min(Math.max(st.debt, -bps * 0.25), bps * 5); // burst 250 ms, max hold 5 s (< engine 12 s socket timeout)
    return st.debt > 0;
  }

  _tick() {
    const now = Date.now();
    const dt = Math.max(0.001, (now - this._lastTick) / 1000);
    this._lastTick = now;
    const running = [...this.getJobs()].filter(j => j.status === 'downloading' && j.activeWorkers);
    const hold = new Set();
    if (this.globalBps > 0 && this._bucketOver('global', running, this.globalBps, dt)) running.forEach(j => hold.add(j));
    for (const j of running) {
      const bps = this.jobBps.get(j.id);
      if (bps && this._bucketOver(`job:${j.id}`, [j], bps, dt)) hold.add(j);
    }

    const live = new Set();
    for (const j of running) {
      const limited = this.globalBps > 0 || this.jobBps.has(j.id);
      for (const [segId, w] of j.activeWorkers) {
        // Pause the IncomingMessage (not the raw socket: http's _read would resume it). Its buffer fills,
        // the parser stops reading the socket and TCP backpressure slows the server.
        const res = w.req && w.req.res;
        if (!res || res.destroyed) continue;
        live.add(res);
        const seg = j.segments.find(s => s.id === segId);
        if (limited && seg) seg.slowTicks = 0; // throttling skews per-socket speed; don't flag stragglers
        if (hold.has(j)) {
          if (!res.isPaused()) res.pause();
          this._paused.set(res, j);
          if (seg) seg.lastDataTime = now;
        } else if (this._paused.has(res)) {
          res.resume();
          this._paused.delete(res);
        }
      }
    }
    for (const res of [...this._paused.keys()]) if (!live.has(res)) this._paused.delete(res);
  }

  _resumeAll() {
    for (const res of this._paused.keys()) if (!res.destroyed) res.resume();
    this._paused.clear();
  }
}

// ───────────────────────── Wiring ─────────────────────────
/**
 * One call per job in server.js (after attachJobEvents, before/after start):
 *   attachIdmFeatures(job, { baseDir: DEFAULT_SAVE_DIR, autoCategory: true, expectedHash: body.expectedHash })
 * Adds job.toJSON().idm = { category, checksum:{status,algo,expected,actual,source,ms}, linkExpired }.
 */
function attachIdmFeatures(job, { baseDir, autoCategory = true, verify = true, expectedHash = '', alwaysHash = false, resolveFreshUrl } = {}) {
  job.idmChecksum = { status: 'none' };
  job.idmCategory = null;
  job.linkExpired = false;

  const origToJSON = job.toJSON.bind(job);
  job.toJSON = () => ({ ...origToJSON(), idm: { category: job.idmCategory, checksum: job.idmChecksum, linkExpired: job.linkExpired } });

  const detachWatch = watchExpiredLink(job, { resolveFreshUrl });
  let hasher = null;
  let expectation = null;
  let lookupDone = null;

  const resolveExpectation = async () => {
    let ipsw = null;
    if (job.resolverType === 'ipsw' || /\.ipsw(\?|$)/i.test(job.finalUrl || '')) {
      ipsw = await lookupIpswHashes(job.url, job.finalUrl).catch(() => null);
    }
    expectation = pickExpected({ expectedHash, ipsw, engineSha1: job.expectedSha1 });
    if (expectation) job.idmChecksum = { status: 'pending', algo: expectation.algo, expected: expectation.hex, source: expectation.source };
    const algo = expectation ? expectation.algo : (alwaysHash ? 'sha256' : null);
    if (algo && job.resolverType !== 'youtube') {
      hasher = new ProgressiveHasher(job, algo);
      hasher.start();
    }
  };

  const onUpdate = () => {
    if (verify && !lookupDone && job.status === 'downloading') lookupDone = resolveExpectation().catch(() => {});
  };
  job.on('update', onUpdate);

  const onCompleted = async () => {
    try {
      if (verify) {
        if (!lookupDone) lookupDone = resolveExpectation().catch(() => {});
        await lookupDone;
        const algo = expectation ? expectation.algo : (alwaysHash ? 'sha256' : null);
        if (algo && job.filePath && fs.existsSync(job.filePath)) {
          job.idmChecksum = { ...job.idmChecksum, status: 'verifying', algo };
          job.emit('update', job.toJSON());
          const t0 = Date.now();
          const size = (await fsp.stat(job.filePath)).size;
          const actual = hasher ? await hasher.finalize(size) : (await hashFile(job.filePath, [algo]))[algo];
          const ok = expectation ? actual === expectation.hex : null;
          job.idmChecksum = { ...job.idmChecksum, actual, status: ok === null ? 'computed' : (ok ? 'ok' : 'mismatch'), ms: Date.now() - t0 };
        }
      }
      if (autoCategory && baseDir) job.idmCategory = await relocateToCategory(job, baseDir);
    } catch (e) {
      job.idmChecksum = { ...job.idmChecksum, status: 'error', error: e.message };
    }
    job.emit('update', job.toJSON());
  };
  job.on('completed', onCompleted);

  return {
    refresh: (newUrl, o) => refreshJobUrl(job, newUrl, o),
    detach() {
      detachWatch();
      hasher?.stop();
      job.off('update', onUpdate);
      job.off('completed', onCompleted);
      job.toJSON = origToJSON;
    }
  };
}

module.exports = {
  CATEGORIES, categorize, categorizeSaveDir, relocateToCategory,
  detectAlgo, hashFile, ProgressiveHasher, lookupIpswHashes, pickExpected,
  refreshJobUrl, watchExpiredLink,
  expandBatchPattern, DownloadQueue,
  SpeedLimiter,
  attachIdmFeatures
};
