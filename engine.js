const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Persistent Keep-Alive Connection Pools (0ms TLS/TCP reuse during Work-Stealing)
const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 256,
  maxFreeSockets: 128,
  scheduling: 'fifo'
});

const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 256,
  maxFreeSockets: 128,
  scheduling: 'fifo',
  rejectUnauthorized: false
});

function findBinary(name) {
  const exeName = process.platform === 'win32' || name.endsWith('.exe') ? name : name.replace(/\.exe$/i, '');
  const candidates = [
    path.join(__dirname, 'bin', exeName),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Duytai', 'bin', exeName),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'HyperIDM', 'bin', exeName),
    path.join(process.env.LOCALAPPDATA || '', 'hermes', 'tools', 'ffmpeg-9.0.1-win32-x64', 'bin', exeName),
    path.join(process.env.LOCALAPPDATA || '', 'hermes', 'tools', 'ffmpeg-9.0.1-win32-x64', exeName),
    path.join('/opt/homebrew/bin', exeName),
    path.join('/usr/local/bin', exeName),
    path.join('/usr/bin', exeName)
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return exeName;
}

/**
 * HyperIDM Ultra v2.0 — 64-Bit Core Engine (TitanFetch Architecture)
 * - Smart URL Resolver:
 *   1) Auto-resolves ipsw.me/download/<device>/<build> via official IPSW API v4 -> Apple CDN direct firmware
 *   2) Auto-resolves YouTube / Streaming URLs via bundled yt-dlp -> Dual 64-thread Range Engine + FFmpeg zero-reencode muxing
 * - Wave-0 Instant Parallel Connection Burst (up to 128 concurrent streams)
 * - Persistent Keep-Alive Socket Pool (0ms TCP/TLS handshake on Work-Stealing)
 * - Multi-IP DNS Edge Pool Round-Robin (defeats single-IP CDN throttling)
 * - YouTube Anti-Throttle 4MB Micro-Chunking (bypasses googlevideo.com per-range rate limiter)
 * - Zero-Rebuild In-Place Sparse Pre-Allocation (0ms stitch time at 100%, 1x SSD TBW)
 * - 1MB Write Coalescing Ring Buffer per worker (64x larger than IDM's 16KB SChannel buffer)
 * - Dynamic In-Flight Boundary Shrink & Straggler Watchdog
 */
class DownloadJob extends EventEmitter {
  constructor(options) {
    super();
    this.id = options.id || crypto.randomUUID();
    this.url = options.url;
    this.finalUrl = options.url;
    this.saveDir = options.saveDir || path.join(process.env.USERPROFILE || 'C:\\Users\\admin', 'Downloads');
    this.fileName = options.fileName || '';
    this.maxConnections = Math.min(Math.max(parseInt(options.maxConnections || 64, 10), 1), 128);
    this.effectiveMaxConnections = this.maxConnections;
    this._targetMaxConnections = this.maxConnections;
    this._rateLimitUntil = 0;
    this._rateLimitTimer = null;
    this._badIps = new Map();
    this._ipStats = new Map();
    this._completedSinceDecrease = 0;
    this.hedgeWins = 0;
    this.headers = options.headers || {};
    this.videoQuality = options.videoQuality || 'best'; // best | 1080p | 720p | 480p | 360p
    this.maxBytesLimit = options.maxBytesLimit || 0; // Optional cap for partial benchmark tests
    this.userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    this.status = 'queued'; // queued | resolving | probing | downloading | muxing | paused | completed | error | canceled
    this.resolverType = 'direct'; // direct | ipsw | youtube
    this.error = null;
    this.totalBytes = 0;
    this.downloadedBytes = 0;
    this.acceptRanges = false;
    this.etag = '';
    this.lastModified = '';
    this.expectedSha1 = '';
    this.mimeType = 'application/octet-stream';
    this.cdnIps = [];
    this.serverHeader = '';

    this.startTime = 0;
    this.endTime = 0;
    this.elapsedMs = 0;
    this.currentSpeedBps = 0;
    this.peakSpeedBps = 0;
    this.etaSeconds = null;
    this.speedHistory = [];
    this.stealCount = 0;
    this.recycleCount = 0;

    this.segments = [];
    this.activeWorkers = new Map();
    this.fileHandle = null;
    this.filePath = '';
    this.stateFilePath = '';

    this._speedTimer = null;
    this._stateTimer = null;
    this._lastTickBytes = 0;
    this._lastTickTime = 0;
    this._minSplitSize = 1024 * 1024; // 1 MB minimum steal size
    this._writeBufferSize = 1024 * 1024; // 1 MB write coalescing buffer
    this._globalPendingWriteBytes = 0;
    this._maxGlobalPendingWriteBytes = 96 * 1024 * 1024; // 96 MB global write-queue RAM cap
    this._maxWorkerPendingWriteBytes = 8 * 1024 * 1024; // 8 MB per-worker write-queue cap
    this._savingState = false;
    this._stateSaveQueued = false;
  }

  toJSON() {
    const progress = this.totalBytes > 0
      ? Math.min(100, Number(((this.downloadedBytes / this.totalBytes) * 100).toFixed(2)))
      : 0;
    return {
      id: this.id,
      url: this.url,
      finalUrl: this.finalUrl,
      resolverType: this.resolverType,
      fileName: this.fileName || path.basename(this.filePath || 'downloading.bin'),
      filePath: this.filePath,
      saveDir: this.saveDir,
      status: this.status,
      error: this.error,
      totalBytes: this.totalBytes,
      downloadedBytes: this.downloadedBytes,
      progress,
      maxConnections: this.maxConnections,
      acceptRanges: this.acceptRanges,
      expectedSha1: this.expectedSha1,
      cdnIps: this.cdnIps,
      serverHeader: this.serverHeader,
      currentSpeedBps: this.currentSpeedBps,
      peakSpeedBps: this.peakSpeedBps,
      etaSeconds: this.etaSeconds,
      elapsedMs: (this.status === 'downloading' || this.status === 'muxing') && this.startTime
        ? this.elapsedMs + (Date.now() - this.startTime)
        : this.elapsedMs,
      stealCount: this.stealCount,
      recycleCount: this.recycleCount,
      speedHistory: this.speedHistory.slice(-40),
      segments: this.segments.map(s => ({
        id: s.id,
        start: s.start,
        current: s.current,
        end: s.end,
        status: s.status,
        speedBps: s.speedBps || 0,
        ip: s.ip || '',
        progress: s.end >= s.start
          ? Math.min(100, Math.round(((s.current - s.start) / Math.max(1, (s.end - s.start + 1))) * 100))
          : 100
      }))
    };
  }

  async start() {
    if (this.status === 'downloading' || this.status === 'probing' || this.status === 'resolving') return;
    this.error = null;
    this.status = 'resolving';
    this.emit('update', this.toJSON());

    try {
      await fsp.mkdir(this.saveDir, { recursive: true });

      // 1. Check if URL is a YouTube / Streaming Video URL
      if (this._isYouTubeOrMediaUrl(this.url)) {
        this.resolverType = 'youtube';
        await this._executeYouTubeMultiStreamPipeline();
        return;
      }

      // 2. Check if URL is an ipsw.me webpage link (e.g. https://ipsw.me/download/Mac15,12/23F79/)
      if (this._isIpswMeUrl(this.url)) {
        this.resolverType = 'ipsw';
        const resolved = await this._resolveIpswMeUrl(this.url);
        this.finalUrl = resolved.url;
        this.expectedSha1 = resolved.sha1sum || '';
        if (!this.fileName && resolved.fileName) {
          this.fileName = resolved.fileName;
        }
      }

      this.status = 'probing';
      this.emit('update', this.toJSON());

      if (!this.filePath || this.segments.length === 0) {
        const meta = await this._probeUrl(this.finalUrl);
        this.finalUrl = meta.finalUrl;
        this.totalBytes = this.maxBytesLimit > 0 ? Math.min(meta.totalBytes, this.maxBytesLimit) : meta.totalBytes;
        this.acceptRanges = meta.acceptRanges;
        this.etag = meta.etag;
        this.lastModified = meta.lastModified;
        this.mimeType = meta.mimeType;
        this.serverHeader = meta.serverHeader;

        if (!this.fileName) {
          this.fileName = meta.fileName || this._inferFileName(this.finalUrl);
        }
        this.filePath = await this._resolveUniqueFilePath(path.join(this.saveDir, this.fileName));
        this.fileName = path.basename(this.filePath);
        this.stateFilePath = `${this.filePath}.hyper.json`;

        await this._resolveCdnPool(this.finalUrl);

        const resumed = await this._tryLoadStateJournal();
        if (!resumed) {
          this._initializeSegments();
        }
      } else {
        await this._resolveCdnPool(this.finalUrl);
      }

      await this._openAndPreallocateTargetFile();

      this.status = 'downloading';
      this._globalPendingWriteBytes = 0;
      this.startTime = Date.now();
      this._lastTickTime = Date.now();
      this._lastTickBytes = this.downloadedBytes;

      this._startTelemetryLoop();
      this._scheduleWorkers();
      this.emit('update', this.toJSON());
    } catch (err) {
      this.status = 'error';
      this.error = err.message || String(err);
      await this._cleanupHandles();
      this.emit('update', this.toJSON());
    }
  }

  _isIpswMeUrl(u) {
    return /^https?:\/\/(www\.)?ipsw\.me\/download\/([^/]+)\/([^/?#]+)/i.test(u);
  }

  async _resolveIpswMeUrl(u) {
    const m = /^https?:\/\/(www\.)?ipsw\.me\/download\/([^/]+)\/([^/?#]+)/i.exec(u);
    if (!m) throw new Error('Invalid ipsw.me URL format');
    const identifier = m[2];
    const buildid = m[3];
    const apiUrl = `https://api.ipsw.me/v4/ipsw/${encodeURIComponent(identifier)}/${encodeURIComponent(buildid)}`;

    return new Promise((resolve, reject) => {
      https.get(apiUrl, {
        headers: { 'User-Agent': this.userAgent, 'Accept': 'application/json' }
      }, (res) => {
        let raw = '';
        res.on('data', d => { raw += d.toString(); });
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            if (!data.url) return reject(new Error('IPSW API did not return a direct firmware URL'));
            resolve({
              url: data.url,
              filesize: data.filesize || 0,
              sha1sum: data.sha1sum || '',
              fileName: path.basename(new URL(data.url).pathname)
            });
          } catch (e) {
            reject(new Error(`Failed to parse IPSW API response: ${e.message}`));
          }
        });
      }).on('error', reject);
    });
  }

  _isYouTubeOrMediaUrl(u) {
    return /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch|shorts)|youtu\.be\/)/i.test(u);
  }

  async _executeYouTubeMultiStreamPipeline() {
    const ytdlp = findBinary('yt-dlp.exe');
    const ffmpeg = findBinary('ffmpeg.exe');

    // Choose optimal high-speed direct HTTPS byte-range formats (avoids slow HLS m3u8 playlists)
    const formatSelector = this.videoQuality === '1080p'
      ? '299+140/137+140/bestvideo[height<=1080][protocol=https]+bestaudio[protocol=https]/best[height<=1080]'
      : (this.videoQuality === '720p'
        ? '298+140/136+140/bestvideo[height<=720][protocol=https]+bestaudio[protocol=https]/best[height<=720]'
        : '135+140/134+140/18/best[protocol=https]');

    const info = await new Promise((resolve, reject) => {
      execFile(ytdlp, ['--no-warnings', '-f', formatSelector, '--dump-single-json', this.url], {
        maxBuffer: 32 * 1024 * 1024
      }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Cannot parse YouTube stream metadata: ${e.message}`));
        }
      });
    });

    const cleanTitle = this._sanitizeFileName(info.title || `youtube_${info.id || Date.now()}`);
    if (!this.fileName) {
      this.fileName = `${cleanTitle}.mp4`;
    } else if (!this.fileName.toLowerCase().endsWith('.mp4')) {
      this.fileName = `${this.fileName}.mp4`;
    }

    this.filePath = await this._resolveUniqueFilePath(path.join(this.saveDir, this.fileName));
    this.fileName = path.basename(this.filePath);
    this.serverHeader = 'YouTube Googlevideo Multi-Range Engine';

    const formats = Array.isArray(info.requested_formats) && info.requested_formats.length > 0
      ? info.requested_formats
      : [{ url: info.url, filesize: info.filesize || info.filesize_approx || 0, ext: info.ext || 'mp4' }];

    this.startTime = Date.now();

    if (formats.length === 1) {
      this.finalUrl = formats[0].url;
      const meta = await this._probeUrl(this.finalUrl);
      this.totalBytes = meta.totalBytes;
      this.acceptRanges = meta.acceptRanges;
      await this._resolveCdnPool(this.finalUrl);
      this._initializeSegments();
      await this._openAndPreallocateTargetFile();
      this.status = 'downloading';
      this._lastTickTime = Date.now();
      this._lastTickBytes = 0;
      this._startTelemetryLoop();
      this._scheduleWorkers();
      return;
    }

    // Dual Parallel 64-Thread Engine for Video Track + Audio Track -> Instant FFmpeg Copy Mux
    const vTrack = formats[0];
    const aTrack = formats[1];
    const vTempPath = `${this.filePath}.video.tmp`;
    const aTempPath = `${this.filePath}.audio.tmp`;

    const vJob = new DownloadJob({
      url: vTrack.url,
      saveDir: this.saveDir,
      fileName: path.basename(vTempPath),
      maxConnections: Math.max(16, Math.floor(this.maxConnections * 0.75))
    });
    const aJob = new DownloadJob({
      url: aTrack.url,
      saveDir: this.saveDir,
      fileName: path.basename(aTempPath),
      maxConnections: Math.max(8, Math.floor(this.maxConnections * 0.25))
    });

    this.status = 'downloading';
    const syncSubJobs = () => {
      const vJson = vJob.toJSON();
      const aJson = aJob.toJSON();
      this.totalBytes = (vJson.totalBytes || vTrack.filesize || 0) + (aJson.totalBytes || aTrack.filesize || 0);
      this.downloadedBytes = (vJson.downloadedBytes || 0) + (aJson.downloadedBytes || 0);
      this.currentSpeedBps = (vJson.currentSpeedBps || 0) + (aJson.currentSpeedBps || 0);
      if (this.currentSpeedBps > this.peakSpeedBps) this.peakSpeedBps = this.currentSpeedBps;
      this.stealCount = (vJson.stealCount || 0) + (aJson.stealCount || 0);
      this.recycleCount = (vJson.recycleCount || 0) + (aJson.recycleCount || 0);
      this.cdnIps = Array.from(new Set([...(vJson.cdnIps || []), ...(aJson.cdnIps || [])]));
      this.segments = [
        ...(vJson.segments || []).slice(0, 48),
        ...(aJson.segments || []).slice(0, 16).map((s, idx) => ({ ...s, id: 48 + idx }))
      ];
      if (this.totalBytes > 0 && this.currentSpeedBps > 0) {
        this.etaSeconds = Math.ceil(Math.max(0, this.totalBytes - this.downloadedBytes) / this.currentSpeedBps);
      }
      this.emit('update', this.toJSON());
    };

    vJob.on('update', syncSubJobs);
    aJob.on('update', syncSubJobs);

    await Promise.all([
      new Promise((res, rej) => {
        vJob.on('completed', res);
        vJob.on('update', s => { if (s.status === 'error') rej(new Error(s.error)); });
        vJob.start();
      }),
      new Promise((res, rej) => {
        aJob.on('completed', res);
        aJob.on('update', s => { if (s.status === 'error') rej(new Error(s.error)); });
        aJob.start();
      })
    ]);

    this.status = 'muxing';
    this.emit('update', this.toJSON());

    await new Promise((resolve, reject) => {
      execFile(ffmpeg, [
        '-y',
        '-i', vJob.filePath,
        '-i', aJob.filePath,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        this.filePath
      ], (err, stdout, stderr) => {
        if (err) return reject(new Error(`FFmpeg mux error: ${stderr || err.message}`));
        resolve();
      });
    });

    await fsp.unlink(vJob.filePath).catch(() => {});
    await fsp.unlink(aJob.filePath).catch(() => {});

    const finalStat = await fsp.stat(this.filePath).catch(() => null);
    if (finalStat) {
      this.totalBytes = finalStat.size;
      this.downloadedBytes = finalStat.size;
    }

    this.status = 'completed';
    this.endTime = Date.now();
    this.elapsedMs = this.endTime - this.startTime;
    this.currentSpeedBps = 0;
    this.etaSeconds = 0;
    this.emit('update', this.toJSON());
    this.emit('completed', this.toJSON());
  }

  async pause() {
    if (this.status !== 'downloading' && this.status !== 'probing') return;
    this.status = 'paused';
    if (this.startTime) {
      this.elapsedMs += Date.now() - this.startTime;
      this.startTime = 0;
    }
    this.currentSpeedBps = 0;
    await this._abortAllWorkers();
    await this._saveStateJournal();
    await this._cleanupHandles();
    this.emit('update', this.toJSON());
  }

  async cancel(deleteFile = true) {
    this.status = 'canceled';
    this.currentSpeedBps = 0;
    await this._abortAllWorkers();
    await this._cleanupHandles();
    if (deleteFile) {
      if (this.filePath && fs.existsSync(this.filePath)) {
        await fsp.unlink(this.filePath).catch(() => {});
      }
      if (this.stateFilePath && fs.existsSync(this.stateFilePath)) {
        await fsp.unlink(this.stateFilePath).catch(() => {});
      }
    }
    this.emit('update', this.toJSON());
  }

  async _probeUrl(targetUrl, redirectCount = 0) {
    if (redirectCount > 10) throw new Error('Too many redirects');
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    return new Promise((resolve, reject) => {
      const req = transport.request(targetUrl, {
        method: 'GET',
        agent: isHttps ? sharedHttpsAgent : sharedHttpAgent,
        headers: {
          'User-Agent': this.userAgent,
          'Accept': '*/*',
          'Range': 'bytes=0-0',
          'Connection': 'keep-alive',
          ...this.headers
        },
        timeout: 15000,
        rejectUnauthorized: false
      }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          this._probeUrl(nextUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        if (code < 200 || code >= 400) {
          res.resume();
          reject(new Error(`HTTP Error ${code} (${res.statusMessage || 'Failed'})`));
          return;
        }

        let totalBytes = 0;
        let acceptRanges = false;
        const contentRange = res.headers['content-range'];
        if (code === 206 && contentRange) {
          acceptRanges = true;
          const match = /\/(\d+)$/.exec(contentRange);
          if (match) totalBytes = parseInt(match[1], 10);
        } else if (res.headers['content-length']) {
          totalBytes = parseInt(res.headers['content-length'], 10);
          acceptRanges = (res.headers['accept-ranges'] || '').toLowerCase() === 'bytes';
        }

        const cd = res.headers['content-disposition'] || '';
        let fileName = '';
        const fnStar = /filename\*=UTF-8''([^;\r\n]+)/i.exec(cd);
        const fnPlain = /filename="?([^";\r\n]+)"?/i.exec(cd);
        if (fnStar) {
          try { fileName = decodeURIComponent(fnStar[1]); } catch { fileName = fnStar[1]; }
        } else if (fnPlain) {
          fileName = fnPlain[1].trim();
        }

        res.destroy();

        resolve({
          finalUrl: targetUrl,
          totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
          acceptRanges,
          etag: res.headers['etag'] || '',
          lastModified: res.headers['last-modified'] || '',
          mimeType: res.headers['content-type'] || 'application/octet-stream',
          serverHeader: res.headers['server'] || res.headers['via'] || 'CDN',
          fileName: this._sanitizeFileName(fileName)
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Probe connection timed out'));
      });
      req.end();
    });
  }

  async _resolveCdnPool(targetUrl) {
    try {
      const parsed = new URL(targetUrl);
      const unique = new Set();
      try {
        const ips4 = await dns.resolve4(parsed.hostname);
        if (Array.isArray(ips4)) for (const ip of ips4) unique.add(ip);
      } catch {}
      if (unique.size === 0) {
        try {
          const all = await dns.lookup(parsed.hostname, { all: true });
          if (Array.isArray(all)) for (const entry of all) if (entry && entry.address) unique.add(entry.address);
        } catch {}
      }
      this.cdnIps = unique.size > 0 ? Array.from(unique) : [parsed.hostname];
    } catch {
      try {
        const parsed = new URL(targetUrl);
        this.cdnIps = [parsed.hostname];
      } catch {
        this.cdnIps = [];
      }
    }
  }

  _pickHealthyIp(seg, excludeIp = '') {
    const pool = this.cdnIps;
    if (!pool || pool.length === 0) return '';
    const now = Date.now();
    const healthy = [];
    for (const ip of pool) {
      if (now >= (this._badIps.get(ip) || 0)) healthy.push(ip);
    }
    const candidates = healthy.length > 0 ? healthy : pool;
    const filtered = (excludeIp && candidates.length > 1)
      ? candidates.filter(ip => ip !== excludeIp)
      : candidates;
    if (filtered.length === 1) return filtered[0];

    // Epsilon-greedy (85% fastest EWMA IP, 15% explore other PoPs)
    const explore = ((seg.id + (seg.retries || 0)) % 7) === 0;
    if (!explore && this._ipStats.size > 0) {
      let bestIp = null;
      let bestScore = -1;
      for (const ip of filtered) {
        const st = this._ipStats.get(ip);
        if (!st) return ip; // Optimistically probe unmeasured IP first
        if (st.ewmaBps > bestScore) {
          bestScore = st.ewmaBps;
          bestIp = ip;
        }
      }
      if (bestIp && bestScore > 0) return bestIp;
    }
    const startIdx = (seg.id + (seg.retries || 0)) % filtered.length;
    return filtered[startIdx];
  }

  _initializeSegments() {
    this.segments = [];
    this.downloadedBytes = 0;

    if (!this.acceptRanges || this.totalBytes <= 0) {
      this.effectiveMaxConnections = 1;
      this._targetMaxConnections = 1;
      this.segments.push({
        id: 0,
        start: 0,
        current: 0,
        end: this.totalBytes > 0 ? this.totalBytes - 1 : -1,
        status: 'pending',
        speedBps: 0,
        ip: '',
        retries: 0,
        bytesInWindow: 0
      });
      return;
    }

    // Smart Auto-Scaling theo dung lượng file để tối ưu TLS handshake vs max throughput
    let smartCap = this.maxConnections;
    if (this.totalBytes < 512 * 1024) smartCap = 1;
    else if (this.totalBytes < 4 * 1024 * 1024) smartCap = Math.min(this.maxConnections, 8);
    else if (this.totalBytes < 32 * 1024 * 1024) smartCap = Math.min(this.maxConnections, 32);
    this._targetMaxConnections = Math.max(1, smartCap);
    this.effectiveMaxConnections = this._targetMaxConnections;

    // For googlevideo.com, slice into <= 4MB micro-chunks to bypass YouTube per-connection throttling
    const isGoogleVideo = this.finalUrl.includes('googlevideo.com');
    if (isGoogleVideo && this.totalBytes > 4 * 1024 * 1024) {
      const microSize = 4 * 1024 * 1024;
      const numChunks = Math.ceil(this.totalBytes / microSize);
      for (let i = 0; i < numChunks; i++) {
        const start = i * microSize;
        const end = Math.min(this.totalBytes - 1, (i + 1) * microSize - 1);
        this.segments.push({
          id: i,
          start,
          current: start,
          end,
          status: 'pending',
          speedBps: 0,
          ip: '',
          retries: 0,
          bytesInWindow: 0
        });
      }
      return;
    }

    const count = Math.min(
      this.maxConnections,
      Math.max(1, Math.floor(this.totalBytes / this._minSplitSize))
    );
    const chunkSize = Math.floor(this.totalBytes / count);

    for (let i = 0; i < count; i++) {
      const start = i * chunkSize;
      const end = (i === count - 1) ? (this.totalBytes - 1) : ((i + 1) * chunkSize - 1);
      this.segments.push({
        id: i,
        start,
        current: start,
        end,
        status: 'pending',
        speedBps: 0,
        ip: '',
        retries: 0,
        bytesInWindow: 0
      });
    }
  }

  async _openAndPreallocateTargetFile() {
    const exists = fs.existsSync(this.filePath);
    this.fileHandle = await fsp.open(this.filePath, exists ? 'r+' : 'w+');

    if (!exists && this.totalBytes > 0) {
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          execFile('fsutil', ['sparse', 'setflag', this.filePath], () => resolve());
        });
      }
      await this.fileHandle.truncate(this.totalBytes);
    }
  }

  _scheduleWorkers() {
    if (this.status !== 'downloading') return;

    const now = Date.now();
    if (now < this._rateLimitUntil) {
      if (!this._rateLimitTimer) {
        this._rateLimitTimer = setTimeout(() => {
          this._rateLimitTimer = null;
          if (this.status === 'downloading') this._scheduleWorkers();
        }, Math.max(50, this._rateLimitUntil - now));
      }
      return;
    }

    const connLimit = this.effectiveMaxConnections || this.maxConnections;
    for (const seg of this.segments) {
      if (seg.status === 'pending' && this.activeWorkers.size < connLimit) {
        this._spawnWorker(seg);
      }
    }

    while (this.acceptRanges && this.activeWorkers.size < connLimit) {
      const stolenSeg = this._tryStealFromLargestSegment();
      if (!stolenSeg) break;
      this._spawnWorker(stolenSeg);
    }

    this._checkCompletion();
  }

  _tryStealFromLargestSegment() {
    let largest = null;
    let maxRemaining = 0;

    for (const seg of this.segments) {
      if (seg.status === 'downloading' && seg.end > seg.current) {
        const remaining = seg.end - seg.current + 1;
        if (remaining > maxRemaining) {
          maxRemaining = remaining;
          largest = seg;
        }
      }
    }

    const isTailPhase = this.totalBytes > 0 && (this.downloadedBytes / this.totalBytes) > 0.80;
    const isFinalPhase = this.totalBytes > 0 && (this.downloadedBytes / this.totalBytes) > 0.97;
    const isHugeFile = this.totalBytes > 2 * 1024 * 1024 * 1024;
    if (this.segments.length >= 1024) return null;
    const minSplit = isHugeFile
      ? (isFinalPhase ? (512 * 1024) : (isTailPhase ? (1024 * 1024) : (4 * 1024 * 1024)))
      : (isTailPhase ? (256 * 1024) : this._minSplitSize);

    if (!largest || maxRemaining < minSplit * 2) {
      return null;
    }

    const half = Math.floor(maxRemaining / 2);
    const newStart = largest.current + half;
    const oldEnd = largest.end;

    largest.end = newStart - 1;

    const newSeg = {
      id: this.segments.length,
      start: newStart,
      current: newStart,
      end: oldEnd,
      status: 'pending',
      speedBps: 0,
      ip: '',
      retries: 0,
      bytesInWindow: 0
    };

    this.segments.push(newSeg);
    this.stealCount++;
    return newSeg;
  }

  _buildRequestOptions(seg, targetIp, rangeStart) {
    const parsed = new URL(this.finalUrl);
    const isHttps = parsed.protocol === 'https:';
    const headers = {
      'User-Agent': this.userAgent,
      'Accept': '*/*',
      'Host': parsed.host,
      'Connection': 'keep-alive',
      ...this.headers
    };
    if (this.acceptRanges && seg.end >= rangeStart) {
      headers['Range'] = `bytes=${rangeStart}-${seg.end}`;
    }
    return {
      isHttps,
      transport: isHttps ? https : http,
      reqOptions: {
        protocol: parsed.protocol,
        hostname: netIsIp(targetIp) ? targetIp : parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        agent: isHttps ? sharedHttpsAgent : sharedHttpAgent,
        headers,
        servername: parsed.hostname,
        rejectUnauthorized: false,
        highWaterMark: this._writeBufferSize
      }
    };
  }

  async _writeVectorAtOffset(buffers, totalBytes, offsetToWrite) {
    let idx = 0;
    let writtenTotal = 0;
    while (writtenTotal < totalBytes) {
      const slice = idx === 0 ? buffers : buffers.slice(idx);
      const { bytesWritten } = await this.fileHandle.writev(slice, offsetToWrite + writtenTotal);
      if (!bytesWritten || bytesWritten <= 0) {
        throw new Error('Zero-byte scatter writev stalled');
      }
      writtenTotal += bytesWritten;
      let rem = bytesWritten;
      while (idx < buffers.length && rem > 0) {
        if (rem >= buffers[idx].length) {
          rem -= buffers[idx].length;
          idx++;
        } else {
          buffers[idx] = buffers[idx].subarray(rem);
          rem = 0;
        }
      }
    }
  }

  _consumeSegmentStream(seg, req, res, initialChain = Promise.resolve(), initialChunk = null) {
    let writeBuffers = [];
    let bufferedBytes = 0;
    let pendingWriteBytes = 0;
    let writeOffset = seg.current;
    let writeChain = initialChain || Promise.resolve();
    let finalized = false;
    let workerSettled = false;
    let pausedForDisk = false;
    const diskWriteError = { err: null };

    const maybeResumeDisk = () => {
      if (pausedForDisk && res && !res.destroyed &&
          pendingWriteBytes <= (this._maxWorkerPendingWriteBytes >> 1) &&
          this._globalPendingWriteBytes <= (this._maxGlobalPendingWriteBytes >> 1)) {
        pausedForDisk = false;
        res.resume();
      }
    };

    const flushBuffer = () => {
      if (bufferedBytes === 0 || !this.fileHandle || diskWriteError.err) return writeChain;
      const bufs = writeBuffers;
      const offsetToWrite = writeOffset;
      const lenToWrite = bufferedBytes;

      writeBuffers = [];
      bufferedBytes = 0;
      writeOffset += lenToWrite;
      pendingWriteBytes += lenToWrite;
      this._globalPendingWriteBytes += lenToWrite;

      writeChain = writeChain.then(async () => {
        try {
          if (diskWriteError.err) return;
          if (this.fileHandle && (this.status === 'downloading' || this.status === 'paused')) {
            await this._writeVectorAtOffset(bufs, lenToWrite, offsetToWrite);
          }
        } catch (err) {
          diskWriteError.err = err;
          if (this.status === 'downloading') {
            this.status = 'error';
            this.error = `Lỗi ghi ổ đĩa tại byte ${offsetToWrite}: ${err.message}`;
            this._abortAllWorkers().then(() => this._cleanupHandles());
            this.emit('update', this.toJSON());
          }
        } finally {
          pendingWriteBytes = Math.max(0, pendingWriteBytes - lenToWrite);
          this._globalPendingWriteBytes = Math.max(0, this._globalPendingWriteBytes - lenToWrite);
          maybeResumeDisk();
          if (this._globalPendingWriteBytes <= (this._maxGlobalPendingWriteBytes >> 1)) {
            for (const w of this.activeWorkers.values()) {
              if (w !== workerEntry && w.maybeResumeDisk) w.maybeResumeDisk();
            }
          }
        }
      });
      return writeChain;
    };

    const workerEntry = {
      req,
      flushBuffer,
      getWriteChain: () => writeChain,
      isDiskPaused: () => pausedForDisk,
      maybeResumeDisk,
      abortSilently: () => {
        if (finalized || workerSettled) return writeChain;
        finalized = true;
        workerSettled = true;
        try { if (res && !res.destroyed) res.destroy(); } catch {}
        try { if (req && !req.destroyed) req.destroy(); } catch {}
        return flushBuffer();
      }
    };
    this.activeWorkers.set(seg.id, workerEntry);

    const settleFailure = (err) => {
      if (workerSettled || finalized) return;
      workerSettled = true;
      if (this.activeWorkers.get(seg.id) !== workerEntry) return;
      flushBuffer().then(() => {
        if (this.activeWorkers.get(seg.id) === workerEntry) {
          this._handleWorkerFailure(seg, err);
        }
      });
    };

    const onChunk = (chunk) => {
      if (this.status !== 'downloading' || finalized || workerSettled) {
        if (res && !res.destroyed) res.destroy();
        return;
      }

      let usableLen = chunk.length;
      if (seg.end >= 0) {
        const remainingAllowed = seg.end - seg.current + 1;
        if (remainingAllowed <= 0) {
          finalized = true;
          if (res && !res.destroyed) res.destroy();
          this._completeSegment(seg, flushBuffer, workerEntry);
          return;
        }
        if (usableLen > remainingAllowed) {
          usableLen = remainingAllowed;
        }
      }

      const slice = usableLen === chunk.length ? chunk : chunk.subarray(0, usableLen);
      writeBuffers.push(slice);
      bufferedBytes += usableLen;

      seg.current += usableLen;
      seg.bytesInWindow += usableLen;
      seg.lastDataTime = Date.now();
      this.downloadedBytes += usableLen;

      if (bufferedBytes >= this._writeBufferSize) {
        flushBuffer();
        if (this.fileHandle && res && !res.destroyed &&
            (pendingWriteBytes >= this._maxWorkerPendingWriteBytes ||
             this._globalPendingWriteBytes >= this._maxGlobalPendingWriteBytes)) {
          pausedForDisk = true;
          res.pause();
        }
      }

      if (seg.end >= 0 && seg.current > seg.end) {
        finalized = true;
        if (res && !res.destroyed) res.destroy();
        this._completeSegment(seg, flushBuffer, workerEntry);
      }
    };

    if (initialChunk && initialChunk.length > 0) {
      onChunk(initialChunk);
      if (finalized) return workerEntry;
    }

    res.on('data', onChunk);
    res.on('end', () => {
      if (finalized || workerSettled || this.status !== 'downloading') return;
      if (seg.end < 0 || seg.current > seg.end) {
        finalized = true;
        this._completeSegment(seg, flushBuffer, workerEntry);
      } else {
        settleFailure(new Error('Stream ended prematurely'));
      }
    });
    res.on('error', settleFailure);
    req.on('error', settleFailure);
    return workerEntry;
  }

  _spawnWorker(seg) {
    if (this.status !== 'downloading') return;
    if (seg.end >= 0 && seg.current > seg.end) {
      seg.status = 'completed';
      seg.speedBps = 0;
      return;
    }

    seg.status = 'downloading';
    seg.lastDataTime = Date.now();
    const parsed = new URL(this.finalUrl);
    const targetIp = this._pickHealthyIp(seg) || parsed.hostname;
    seg.ip = targetIp;

    const { transport, reqOptions } = this._buildRequestOptions(seg, targetIp, seg.current);
    let workerEntry = null;
    let settledEarly = false;

    const failEarly = (err) => {
      if (settledEarly) return;
      settledEarly = true;
      if (workerEntry) return;
      if (this.activeWorkers.get(seg.id)?.req === req) {
        this.activeWorkers.delete(seg.id);
        this._handleWorkerFailure(seg, err);
      }
    };

    const req = transport.request(reqOptions, (res) => {
      const code = res.statusCode || 0;
      if (code < 200 || code >= 300) {
        const retryAfterRaw = res.headers['retry-after'];
        res.destroy();
        const err = new Error(`HTTP ${code}`);
        err.statusCode = code;
        if (retryAfterRaw) {
          const sec = parseInt(String(retryAfterRaw), 10);
          if (!Number.isNaN(sec) && sec > 0) err.retryAfterMs = Math.min(15000, sec * 1000);
        }
        failEarly(err);
        return;
      }
      if (this.status !== 'downloading' || seg.status !== 'downloading') {
        res.destroy();
        return;
      }
      workerEntry = this._consumeSegmentStream(seg, req, res);
    });

    this.activeWorkers.set(seg.id, { req, isDiskPaused: () => false });

    req.on('socket', (sock) => {
      try {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 2000);
      } catch {}
    });

    req.on('error', failEarly);
    req.setTimeout(12000, () => {
      if (this.status === 'downloading') {
        req.destroy(new Error('Socket read timeout'));
      }
    });

    req.end();
  }

  // Google "The Tail at Scale" Hedged Race: phóng request song song trên CDN IP khác nếu 1 kết nối kẹt
  _spawnHedgedRace(seg) {
    if (this.status !== 'downloading' || seg.status !== 'downloading' || !this.acceptRanges || seg._hedging) return;
    if (seg.end >= 0 && seg.current >= seg.end) return;

    seg._hedging = true;
    const expectedStart = seg.current;
    const altIp = this._pickHealthyIp(seg, seg.ip);
    const { transport, reqOptions } = this._buildRequestOptions(seg, altIp || seg.ip, expectedStart);

    let claimed = false;
    let streamPos = expectedStart;

    const stopHedge = (res) => {
      seg._hedging = false;
      try { if (res && !res.destroyed) res.destroy(); } catch {}
      try { if (!req.destroyed) req.destroy(); } catch {}
    };

    const req = transport.request(reqOptions, (res) => {
      const code = res.statusCode || 0;
      if (code < 200 || code >= 300 || this.status !== 'downloading' || seg.status !== 'downloading') {
        return stopHedge(res);
      }

      const onFirstHedgeData = (chunk) => {
        if (claimed) return;
        if (this.status !== 'downloading' || seg.status !== 'downloading') {
          return stopHedge(res);
        }
        const curr = seg.current;
        if (seg.end >= 0 && curr > seg.end) {
          return stopHedge(res);
        }
        const endOfChunk = streamPos + chunk.length;
        if (endOfChunk <= curr) {
          streamPos = endOfChunk;
          return;
        }
        // Hedge đến điểm mới trước primary -> chiếm quyền ghi nguyên tử
        claimed = true;
        seg._hedging = false;
        res.removeListener('data', onFirstHedgeData);
        const firstSlice = curr > streamPos ? chunk.subarray(curr - streamPos) : chunk;
        const oldW = this.activeWorkers.get(seg.id);
        let priorChain = Promise.resolve();
        if (oldW && oldW.abortSilently) {
          priorChain = oldW.abortSilently();
        } else if (oldW && oldW.req) {
          try { oldW.req.destroy(); } catch {}
        }
        if (altIp) seg.ip = altIp;
        this.hedgeWins++;
        this.recycleCount++;
        this._consumeSegmentStream(seg, req, res, priorChain, firstSlice);
      };

      res.on('data', onFirstHedgeData);
      res.once('end', () => { if (!claimed) stopHedge(res); });
      res.once('error', () => { if (!claimed) stopHedge(res); });
    });

    req.on('socket', (sock) => {
      try {
        sock.setNoDelay(true);
        sock.setKeepAlive(true, 2000);
      } catch {}
    });
    req.on('error', () => { if (!claimed) seg._hedging = false; });
    req.setTimeout(3500, () => { if (!claimed) stopHedge(null); });
    req.end();
  }

  _completeSegment(seg, flushBuffer, workerEntry) {
    flushBuffer().then(() => {
      if (!workerEntry || this.activeWorkers.get(seg.id) === workerEntry) {
        this.activeWorkers.delete(seg.id);
      }
      if (this.status !== 'downloading') return;
      seg.status = 'completed';
      seg.speedBps = 0;
      // AIMD Slow-Start Recovery: khôi phục dần số luồng khi kết nối ổn định trở lại
      const targetCap = this._targetMaxConnections || this.maxConnections;
      if (this.effectiveMaxConnections < targetCap) {
        this._completedSinceDecrease++;
        if (this._completedSinceDecrease >= 4) {
          this._completedSinceDecrease = 0;
          this.effectiveMaxConnections = Math.min(targetCap, this.effectiveMaxConnections + 2);
        }
      }
      this._scheduleWorkers();
    });
  }

  _handleWorkerFailure(seg, err) {
    this.activeWorkers.delete(seg.id);
    if (this.status !== 'downloading') return;

    if (seg.end >= 0 && seg.current > seg.end) {
      seg.status = 'completed';
      seg.speedBps = 0;
      this._scheduleWorkers();
      return;
    }

    if (seg.ip && this.cdnIps.length > 1) {
      this._badIps.set(seg.ip, Date.now() + 15000);
    }

    seg.retries = (seg.retries || 0) + 1;
    seg.speedBps = 0;

    const code = err && err.statusCode;
    const isRateLimited = code === 429 || code === 503;
    const isResetBurst = !code && seg.retries >= 2 && /ECONNRESET|ETIMEDOUT|prematurely/i.test((err && err.message) || '');

    if (isRateLimited || isResetBurst) {
      this._completedSinceDecrease = 0;
      this.effectiveMaxConnections = Math.max(4, Math.floor((this.effectiveMaxConnections || this.maxConnections) / 2));
      const cooldown = (err && err.retryAfterMs) || Math.min(8000, 1000 * seg.retries);
      this._rateLimitUntil = Math.max(this._rateLimitUntil, Date.now() + cooldown);
    }

    const maxRetries = isRateLimited ? 24 : 12;
    if (seg.retries > maxRetries) {
      this.status = 'error';
      this.error = `Segment #${seg.id} failed after ${maxRetries} retries: ${err.message}`;
      this._abortAllWorkers().then(() => this._cleanupHandles());
      this.emit('update', this.toJSON());
      return;
    }

    seg.status = 'pending';
    const backoffMs = isRateLimited ? Math.min(8000, (err && err.retryAfterMs) || 800 * seg.retries) : Math.min(2000, 150 * seg.retries);
    setTimeout(() => {
      if (this.status === 'downloading') {
        this._scheduleWorkers();
      }
    }, backoffMs);
  }

  _startTelemetryLoop() {
    this._stopTelemetryLoop();

    this._speedTimer = setInterval(() => {
      if (this.status !== 'downloading') return;
      const now = Date.now();
      const dt = Math.max(0.1, (now - this._lastTickTime) / 1000);
      const dBytes = Math.max(0, this.downloadedBytes - this._lastTickBytes);

      this.currentSpeedBps = Math.round(dBytes / dt);
      if (this.currentSpeedBps > this.peakSpeedBps) {
        this.peakSpeedBps = this.currentSpeedBps;
      }

      if (this.totalBytes > 0 && this.currentSpeedBps > 0) {
        const rem = Math.max(0, this.totalBytes - this.downloadedBytes);
        this.etaSeconds = Math.ceil(rem / this.currentSpeedBps);
      } else {
        this.etaSeconds = null;
      }

      this.speedHistory.push({
        t: now,
        speedBps: this.currentSpeedBps
      });
      if (this.speedHistory.length > 60) this.speedHistory.shift();

      const activeSegs = [];
      const ipAgg = new Map();
      for (const seg of this.segments) {
        if (seg.status === 'downloading') {
          seg.speedBps = Math.round(seg.bytesInWindow / dt);
          seg.bytesInWindow = 0;
          activeSegs.push(seg);
          if (seg.ip) {
            ipAgg.set(seg.ip, (ipAgg.get(seg.ip) || 0) + seg.speedBps);
          }
        } else {
          seg.speedBps = 0;
          seg.bytesInWindow = 0;
        }
      }

      // Update EWMA per CDN Edge IP
      for (const [ip, bps] of ipAgg) {
        const prev = this._ipStats.get(ip);
        const ewma = prev ? Math.round(prev.ewmaBps * 0.7 + bps * 0.3) : bps;
        this._ipStats.set(ip, { ewmaBps: ewma, updatedAt: now });
      }

      // Dynamic BDP Write-Coalescing Buffer Auto-Tuner
      if (this.currentSpeedBps > 150 * 1024 * 1024) {
        this._writeBufferSize = 2 * 1024 * 1024;
      } else if (this.currentSpeedBps > 25 * 1024 * 1024) {
        this._writeBufferSize = 1024 * 1024;
      } else {
        this._writeBufferSize = 256 * 1024;
      }

      const connLimit = this.effectiveMaxConnections || this.maxConnections;

      // Tail-Latency, Hedged Racing & Anti-Throttle Straggler Watchdog
      for (const seg of activeSegs) {
        const w = this.activeWorkers.get(seg.id);
        if (w && w.isDiskPaused && w.isDiskPaused()) {
          seg.lastDataTime = now;
          seg.slowTicks = 0;
          continue;
        }
        const idleMs = now - (seg.lastDataTime || now);
        const rem = seg.end - seg.current + 1;

        // 0) Google "The Tail at Scale" Hedged Request nếu có slot nhàn rỗi hoặc sắp xong 95%+
        const avgSegSpeed = (activeSegs.length >= 2 && this.currentSpeedBps > 512 * 1024)
          ? (this.currentSpeedBps / activeSegs.length)
          : 0;
        const inTailZone = this.totalBytes > 0 && (this.downloadedBytes / this.totalBytes) >= 0.94;
        const hedgeTrigger = (idleMs > 900 && rem > 64 * 1024) ||
          (inTailZone && rem > 128 * 1024 && avgSegSpeed > 0 && seg.speedBps < avgSegSpeed * 0.35);

        if (this.acceptRanges && !seg._hedging && hedgeTrigger &&
            (this.activeWorkers.size < connLimit || this.cdnIps.length > 1)) {
          this._spawnHedgedRace(seg);
        }

        // 1) Recycle any socket stalled with 0 bytes for > 2.2 seconds
        if (idleMs > 2200 && rem > 0) {
          seg.lastDataTime = now;
          this.recycleCount++;
          if (w && w.req) {
            w.req.destroy(new Error('Stalled socket recycled (>2.2s idle)'));
          }
          continue;
        }
        // 2) Recycle heavily throttled socket compared to sibling connections
        if (activeSegs.length >= 2 && this.currentSpeedBps > 1024 * 1024) {
          if (rem > 512 * 1024 && seg.speedBps < avgSegSpeed * 0.10) {
            seg.slowTicks = (seg.slowTicks || 0) + 1;
            if (seg.slowTicks >= 3) {
              seg.slowTicks = 0;
              this.recycleCount++;
              if (w && w.req) {
                w.req.destroy(new Error('Straggler connection recycled to faster CDN edge'));
              }
            }
          } else {
            seg.slowTicks = 0;
          }
        }
      }

      if (this.acceptRanges && this.activeWorkers.size < connLimit) {
        this._scheduleWorkers();
      }

      this._lastTickTime = now;
      this._lastTickBytes = this.downloadedBytes;
      this.emit('update', this.toJSON());
    }, 500);

    this._stateTimer = setInterval(() => {
      if (this.status === 'downloading') {
        this._saveStateJournal().catch(() => {});
      }
    }, 1500);
  }

  _stopTelemetryLoop() {
    if (this._speedTimer) {
      clearInterval(this._speedTimer);
      this._speedTimer = null;
    }
    if (this._stateTimer) {
      clearInterval(this._stateTimer);
      this._stateTimer = null;
    }
    if (this._rateLimitTimer) {
      clearTimeout(this._rateLimitTimer);
      this._rateLimitTimer = null;
    }
  }

  async _checkCompletion() {
    if (this.status !== 'downloading') return;
    const allDone = this.segments.length > 0 && this.segments.every(s => s.status === 'completed');
    if (!allDone || this.activeWorkers.size > 0) return;

    this.status = 'completed';
    this.endTime = Date.now();
    if (this.startTime) {
      this.elapsedMs += this.endTime - this.startTime;
      this.startTime = 0;
    }
    if (this.totalBytes <= 0) {
      this.totalBytes = this.downloadedBytes;
    } else {
      this.downloadedBytes = this.totalBytes;
    }
    this.currentSpeedBps = 0;
    this.etaSeconds = 0;

    await this._cleanupHandles();
    if (this.stateFilePath && fs.existsSync(this.stateFilePath)) {
      await fsp.unlink(this.stateFilePath).catch(() => {});
    }

    this.emit('update', this.toJSON());
    this.emit('completed', this.toJSON());
  }

  async _abortAllWorkers() {
    this._stopTelemetryLoop();
    const flushes = [];
    for (const [, worker] of this.activeWorkers.entries()) {
      if (worker.flushBuffer) flushes.push(worker.flushBuffer());
      if (worker.req) worker.req.destroy();
      if (worker.getWriteChain) flushes.push(worker.getWriteChain());
    }
    this.activeWorkers.clear();
    await Promise.allSettled(flushes);

    for (const seg of this.segments) {
      if (seg.status === 'downloading') {
        seg.status = 'pending';
        seg.speedBps = 0;
      }
    }
  }

  async _cleanupHandles() {
    this._stopTelemetryLoop();
    if (this.fileHandle) {
      try {
        if (this.totalBytes > 0 && this.totalBytes <= 512 * 1024 * 1024) {
          await this.fileHandle.datasync().catch(() => {});
        }
        await this.fileHandle.close();
      } catch {}
      this.fileHandle = null;
    }
  }

  async _saveStateJournal() {
    if (!this.stateFilePath || this.status === 'completed' || this.status === 'canceled') return;
    if (this._savingState) {
      this._stateSaveQueued = true;
      return;
    }
    this._savingState = true;
    try {
      const payload = {
        id: this.id,
        url: this.url,
        finalUrl: this.finalUrl,
        fileName: this.fileName,
        filePath: this.filePath,
        totalBytes: this.totalBytes,
        downloadedBytes: this.downloadedBytes,
        acceptRanges: this.acceptRanges,
        etag: this.etag,
        lastModified: this.lastModified,
        maxConnections: this.maxConnections,
        elapsedMs: this.elapsedMs,
        segments: this.segments.map(s => ({
          id: s.id,
          start: s.start,
          current: s.current,
          end: s.end,
          status: s.current > s.end && s.end >= 0 ? 'completed' : 'pending'
        }))
      };
      const jsonStr = this.segments.length > 128 ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
      await fsp.writeFile(this.stateFilePath, jsonStr, 'utf8').catch(() => {});
    } finally {
      this._savingState = false;
      if (this._stateSaveQueued && this.status === 'downloading') {
        this._stateSaveQueued = false;
        this._saveStateJournal().catch(() => {});
      } else {
        this._stateSaveQueued = false;
      }
    }
  }

  async _tryLoadStateJournal() {
    if (!this.stateFilePath || !fs.existsSync(this.stateFilePath) || !fs.existsSync(this.filePath)) {
      return false;
    }
    try {
      const raw = await fsp.readFile(this.stateFilePath, 'utf8');
      const data = JSON.parse(raw);
      if (data.totalBytes !== this.totalBytes || !Array.isArray(data.segments)) return false;

      this.segments = data.segments.map(s => ({
        id: s.id,
        start: s.start,
        current: s.current,
        end: s.end,
        status: s.current > s.end && s.end >= 0 ? 'completed' : 'pending',
        speedBps: 0,
        ip: '',
        retries: 0,
        bytesInWindow: 0
      }));
      this.downloadedBytes = this.segments.reduce((acc, s) => acc + Math.max(0, s.current - s.start), 0);
      return true;
    } catch {
      return false;
    }
  }

  _inferFileName(urlStr) {
    try {
      const u = new URL(urlStr);
      const base = decodeURIComponent(path.basename(u.pathname));
      if (base && base !== '/' && base !== '.' && base !== 'videoplayback') {
        return this._sanitizeFileName(base);
      }
    } catch {}
    return `download_${Date.now()}.bin`;
  }

  _sanitizeFileName(name) {
    if (!name) return '';
    return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
  }

  async _resolveUniqueFilePath(initialPath) {
    if (fs.existsSync(`${initialPath}.hyper.json`)) {
      return initialPath;
    }
    if (!fs.existsSync(initialPath)) return initialPath;

    const dir = path.dirname(initialPath);
    const ext = path.extname(initialPath);
    const base = path.basename(initialPath, ext);
    for (let i = 1; i < 1000; i++) {
      const candidate = path.join(dir, `${base} (${i})${ext}`);
      if (!fs.existsSync(candidate)) return candidate;
    }
    return path.join(dir, `${base}_${Date.now()}${ext}`);
  }
}

function netIsIp(host) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

module.exports = { DownloadJob };
