process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '32';
const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns').promises;
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { execFile } = require('child_process');

// Bounded DNS + Edge Latency Pool Cache (30s TTL, max 200 hostnames)
const DNS_POOL_CACHE = new Map();
const DNS_POOL_TTL_MS = 30000;
const RESERVED_TARGET_PATHS = new Map(); // normalizedPath -> jobId (prevents concurrent filename collisions)

function probeTcpLatency(ip, port, timeoutMs = 350) {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const sock = net.createConnection({ host: ip, port });
    const done = (latency) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      resolve(latency);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(Date.now() - start));
    sock.once('timeout', () => done(Infinity));
    sock.once('error', () => done(Infinity));
  });
}

// Persistent Keep-Alive Connection Pools (0ms TLS/TCP reuse during Work-Stealing, LIFO picks warmest high-cwnd socket)
const sharedHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 512,
  maxFreeSockets: 256,
  scheduling: 'lifo',
  noDelay: true
});

const sharedHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 512,
  maxFreeSockets: 256,
  scheduling: 'lifo',
  noDelay: true,
  maxCachedSessions: 256
});

function findBinary(name) {
  const exeName = process.platform === 'win32' || name.endsWith('.exe')
    ? (process.platform === 'win32' ? name : name.replace(/\.exe$/i, ''))
    : name;
  const candidates = [
    path.join(__dirname, 'bin', exeName),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Duytai', 'bin', exeName),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'HyperIDM', 'bin', exeName),
    path.join(process.env.LOCALAPPDATA || '', 'hermes', 'tools', 'ffmpeg-9.0.1-win32-x64', 'bin', exeName),
    path.join(process.env.LOCALAPPDATA || '', 'hermes', 'tools', 'ffmpeg-9.0.1-win32-x64', exeName),
    path.join('/Applications/Duytai.app/Contents/Resources/bin', exeName),
    path.join(process.env.HOME || '', '.local', 'bin', exeName),
    path.join('/opt/homebrew/bin', exeName),
    path.join('/usr/local/bin', exeName),
    path.join('/usr/bin', exeName)
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return exeName;
}

const GENERIC_FILENAME_RE = /^(?:download|downloading|uc|export|file|attachment|index|videoplayback)(?:\.[a-z0-9]{1,5})?$/i;

function isGenericFileName(name) {
  if (!name || typeof name !== 'string') return true;
  const base = path.basename(name.trim());
  if (!base || base === '.' || base === '/') return true;
  return GENERIC_FILENAME_RE.test(base);
}

function extractGoogleDriveFileId(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return '';
  const m1 = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/i.exec(urlStr);
  if (m1) return m1[1];
  const m2 = /drive\.google\.com\/(?:open|uc)\?(?:[^&]+&)*id=([a-zA-Z0-9_-]{20,})/i.exec(urlStr);
  if (m2) return m2[1];
  const m3 = /drive\.usercontent\.google\.com\/download\?(?:[^&]+&)*id=([a-zA-Z0-9_-]{20,})/i.exec(urlStr);
  if (m3) return m3[1];
  return '';
}

function decodeRfc2047(str) {
  if (!str || typeof str !== 'string' || !str.includes('=?')) return str;
  return str.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === 'B') {
        return Buffer.from(text, 'base64').toString(charset.toLowerCase().includes('utf-8') ? 'utf8' : 'latin1');
      } else if (encoding.toUpperCase() === 'Q') {
        return text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16)));
      }
    } catch {}
    return text;
  });
}

async function parseGoogleDriveFolder(folderUrl) {
  try {
    const parsed = new URL(folderUrl);
    if (!parsed.hostname.includes('drive.google.com') || !parsed.pathname.includes('/folders/')) return [];
    return new Promise((resolve) => {
      const transport = parsed.protocol === 'https:' ? https : http;
      const req = transport.get(folderUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        timeout: 10000
      }, res => {
        let html = '';
        res.on('data', d => { if (html.length < 2000000) html += d; });
        res.on('end', () => {
          const regex = /aria-label="([^"]+?)\s+(?:Unknown|Binary|Archive|Document|Spreadsheet|Video|Audio|PDF|Presentation|Shared|Google|Compressed)[^"]*"[^>]+ssk='[0-9]+:[^:]+:([a-zA-Z0-9_-]{25,45})/g;
          const results = [];
          let m;
          const seen = new Set();
          while ((m = regex.exec(html)) !== null) {
            const fileName = m[1].trim();
            const fileId = m[2].split('-')[0].trim();
            if (!seen.has(fileId)) {
              seen.add(fileId);
              results.push({
                fileName,
                fileId,
                url: `https://drive.usercontent.google.com/download?id=${fileId}&export=download`
              });
            }
          }
          resolve(results);
        });
      });
      req.on('error', () => resolve([]));
      req.on('timeout', () => { req.destroy(); resolve([]); });
    });
  } catch {
    return [];
  }
}

class CloudResolver {
  static resolveGoogle(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const m1 = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/i.exec(urlStr);
    if (m1) return { type: 'gdrive', url: `https://drive.usercontent.google.com/download?id=${m1[1]}&export=download` };
    const m2 = /drive\.google\.com\/(?:open|uc)\?(?:[^&]+&)*id=([a-zA-Z0-9_-]{20,})/i.exec(urlStr);
    if (m2) return { type: 'gdrive', url: `https://drive.usercontent.google.com/download?id=${m2[1]}&export=download` };
    const docM = /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]{20,})/i.exec(urlStr);
    if (docM) return { type: 'gdoc', url: `https://docs.google.com/document/d/${docM[1]}/export?format=docx` };
    const sheetM = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/i.exec(urlStr);
    if (sheetM) return { type: 'gsheet', url: `https://docs.google.com/spreadsheets/d/${sheetM[1]}/export?format=xlsx` };
    const slideM = /docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]{20,})/i.exec(urlStr);
    if (slideM) return { type: 'gslide', url: `https://docs.google.com/presentation/d/${slideM[1]}/export/pptx` };
    return null;
  }

  static resolveDropbox(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    if (/^https?:\/\/(?:www\.)?dropbox\.com\/(?:s|scl\/fi)\//i.test(urlStr)) {
      try {
        const u = new URL(urlStr);
        u.searchParams.set('dl', '1');
        return { type: 'dropbox', url: u.toString() };
      } catch {}
    }
    return null;
  }

  static resolveGit(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const ghM = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(urlStr);
    if (ghM) return { type: 'github-raw', url: `https://raw.githubusercontent.com/${ghM[1]}/${ghM[2]}/${ghM[3]}/${ghM[4]}` };
    const glM = /^https?:\/\/gitlab\.com\/([^/]+)\/([^/]+)\/-\/blob\/([^/]+)\/(.+)$/i.exec(urlStr);
    if (glM) return { type: 'gitlab-raw', url: `https://gitlab.com/${glM[1]}/${glM[2]}/-/raw/${glM[3]}/${glM[4]}` };
    const bbM = /^https?:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/src\/([^/]+)\/(.+)$/i.exec(urlStr);
    if (bbM) return { type: 'bitbucket-raw', url: `https://bitbucket.org/${bbM[1]}/${bbM[2]}/raw/${bbM[3]}/${bbM[4]}` };
    return null;
  }

  static resolvePixeldrain(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const pdM = /^https?:\/\/(?:www\.)?pixeldrain\.com\/u\/([a-zA-Z0-9_-]+)(?:[/?#]|$)/i.exec(urlStr);
    if (pdM) return { type: 'pixeldrain', url: `https://pixeldrain.com/api/file/${pdM[1]}?download` };
    return null;
  }

  static resolveSourceForge(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const sfM = /^https?:\/\/(?:www\.)?sourceforge\.net\/projects\/([^/]+)\/files\/(.+?)\/download(?:[?#]|$)/i.exec(urlStr);
    if (sfM) return { type: 'sourceforge', url: `https://downloads.sourceforge.net/project/${sfM[1]}/${sfM[2]}?use_mirror=autoselect` };
    return null;
  }

  static resolveSharePoint(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    if (/^https?:\/\/[^/]+\.sharepoint\.com\/:[ubxwp]:\/[a-z]\//i.test(urlStr)) {
      try {
        const u = new URL(urlStr);
        u.searchParams.set('download', '1');
        return { type: 'sharepoint', url: u.toString() };
      } catch {}
    }
    return null;
  }

  static resolveHuggingFace(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const hfM = /^https?:\/\/huggingface\.co\/((?:[^/]+\/)?[^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(urlStr);
    if (hfM) return { type: 'huggingface', url: `https://huggingface.co/${hfM[1]}/resolve/${hfM[2]}/${hfM[3]}?download=true` };
    return null;
  }

  static resolveOneDrive(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    if (/onedrive\.live\.com/i.test(urlStr)) {
      try {
        const u = new URL(urlStr);
        const cid = u.searchParams.get('cid');
        const resid = u.searchParams.get('resid') || u.searchParams.get('id');
        const authkey = u.searchParams.get('authkey');
        if (cid && resid) {
          let dlUrl = `https://onedrive.live.com/download?cid=${cid}&resid=${encodeURIComponent(resid)}`;
          if (authkey) dlUrl += `&authkey=${authkey}`;
          return { type: 'onedrive', url: dlUrl };
        }
        if (u.pathname.includes('view.aspx')) {
          u.pathname = u.pathname.replace('view.aspx', 'download.aspx');
          return { type: 'onedrive', url: u.toString() };
        }
      } catch {}
    }
    return null;
  }

  static resolveArchiveOrg(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') return null;
    const arcM = /^https?:\/\/archive\.org\/details\/([^/?#]+)(?:\/(.+))?$/i.exec(urlStr);
    if (arcM) {
      const filePart = arcM[2] ? `/${arcM[2]}` : '';
      return { type: 'archiveorg', url: `https://archive.org/download/${arcM[1]}${filePart}` };
    }
    return null;
  }

  static async resolveMediaFire(urlStr) {
    if (!urlStr || typeof urlStr !== 'string' || !/mediafire\.com\/file\//i.test(urlStr)) return null;
    try {
      return new Promise((resolve) => {
        const req = https.get(urlStr, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          timeout: 8000
        }, res => {
          let html = '';
          res.on('data', d => { if (html.length < 500000) html += d; });
          res.on('end', () => {
            const dlMatch = /href="((?:https?:)?\/\/(?:download\d*\.mediafire\.com|www\.mediafire\.com\/file_download\/)[^"]+)"/i.exec(html) ||
                            /id="downloadButton"[^>]*href="([^"]+)"/i.exec(html) ||
                            /aria-label="Download file"[^>]*href="([^"]+)"/i.exec(html);
            if (dlMatch) {
              let target = dlMatch[1];
              if (target.startsWith('//')) target = 'https:' + target;
              resolve({ type: 'mediafire', url: target });
              return;
            }
            resolve(null);
          });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
      });
    } catch {
      return null;
    }
  }

  static resolveSync(urlStr) {
    if (!urlStr || typeof urlStr !== 'string' || !/^https?:\/\//i.test(urlStr)) return null;
    return CloudResolver.resolveGoogle(urlStr) ||
           CloudResolver.resolveDropbox(urlStr) ||
           CloudResolver.resolveGit(urlStr) ||
           CloudResolver.resolveHuggingFace(urlStr) ||
           CloudResolver.resolveOneDrive(urlStr) ||
           CloudResolver.resolveSharePoint(urlStr) ||
           CloudResolver.resolvePixeldrain(urlStr) ||
           CloudResolver.resolveSourceForge(urlStr) ||
           CloudResolver.resolveArchiveOrg(urlStr) ||
           null;
  }

  static async resolve(urlStr) {
    if (!urlStr || typeof urlStr !== 'string' || !/^https?:\/\//i.test(urlStr)) return null;
    const syncRes = CloudResolver.resolveSync(urlStr);
    if (syncRes) return syncRes;
    if (/mediafire\.com\/file\//i.test(urlStr)) {
      const mf = await CloudResolver.resolveMediaFire(urlStr);
      if (mf) return mf;
    }
    return null;
  }
}

const YT_QUALITY_FORMATS = {
  best: 'bestvideo[protocol=https]+bestaudio[ext=m4a][protocol=https]/bestvideo[protocol=https]+bestaudio[protocol=https]/best[protocol=https]/best',
  '12k': 'bestvideo[height<=8640][protocol=https]+bestaudio[ext=m4a][protocol=https]/bestvideo[height<=8640][protocol=https]+bestaudio[protocol=https]/best[height<=8640][protocol=https]/best',
  '8k': 'bestvideo[height<=4320][protocol=https]+bestaudio[ext=m4a][protocol=https]/bestvideo[height<=4320][protocol=https]+bestaudio[protocol=https]/best[height<=4320][protocol=https]/best',
  '4k': 'bestvideo[height<=2160][protocol=https]+bestaudio[ext=m4a][protocol=https]/bestvideo[height<=2160][protocol=https]+bestaudio[protocol=https]/best[height<=2160][protocol=https]/best',
  '2k': 'bestvideo[height<=1440][protocol=https]+bestaudio[ext=m4a][protocol=https]/bestvideo[height<=1440][protocol=https]+bestaudio[protocol=https]/best[height<=1440][protocol=https]/best',
  '1080p': '299+140/137+140/bestvideo[height<=1080][protocol=https]+bestaudio[ext=m4a][protocol=https]/bestvideo[height<=1080][protocol=https]+bestaudio[protocol=https]/best[height<=1080][protocol=https]/best',
  '720p': '298+140/136+140/bestvideo[height<=720][protocol=https]+bestaudio[ext=m4a][protocol=https]/bestvideo[height<=720][protocol=https]+bestaudio[protocol=https]/best[height<=720][protocol=https]/best',
  '480p': '135+140/bestvideo[height<=480][protocol=https]+bestaudio[ext=m4a][protocol=https]/bestvideo[height<=480][protocol=https]+bestaudio[protocol=https]/best[height<=480][protocol=https]/best',
  '360p': '134+140/18/best[height<=360][protocol=https]/best[protocol=https]',
  audio: 'bestaudio[ext=m4a][protocol=https]/140/bestaudio[protocol=https]/bestaudio'
};

const YT_QUALITY_TIERS = [
  { key: '12k', minH: 5400, maxH: 8640, label: '12K Ultra HD (8640p)' },
  { key: '8k', minH: 3600, maxH: 4320, label: '8K Ultra HD (4320p)' },
  { key: '4k', minH: 1800, maxH: 2160, label: '4K Ultra HD (2160p)' },
  { key: '2k', minH: 1200, maxH: 1440, label: '2K QHD (1440p)' },
  { key: '1080p', minH: 900, maxH: 1080, label: 'Full HD (1080p)' },
  { key: '720p', minH: 600, maxH: 720, label: 'HD (720p)' },
  { key: '480p', minH: 400, maxH: 480, label: 'SD (480p)' },
  { key: '360p', minH: 300, maxH: 360, label: '360p' }
];

function normalizeVideoQuality(q) {
  const s = String(q || 'best').trim().toLowerCase();
  if (!s || s === 'auto' || s === 'max' || s === 'best') return 'best';
  if (s === '12k' || s === '6480p' || s === '6912p' || s === '8640p') return '12k';
  if (s === '8k' || s === '4320p' || s === '4320') return '8k';
  if (s === '4k' || s === 'uhd' || s === '2160p' || s === '2160') return '4k';
  if (s === '2k' || s === 'qhd' || s === '1440p' || s === '1440') return '2k';
  if (s === '1080p' || s === '1080' || s === 'fullhd' || s === 'full hd' || s === 'fhd') return '1080p';
  if (s === '720p' || s === '720' || s === 'hd') return '720p';
  if (s === '480p' || s === '480' || s === 'sd') return '480p';
  if (s === '360p' || s === '360') return '360p';
  if (s === 'audio' || s === 'm4a' || s === 'mp3') return 'audio';
  return YT_QUALITY_FORMATS[s] ? s : 'best';
}

function summarizeSegments(srcSegs, maxBuckets = 64, idOffset = 0) {
  if (!Array.isArray(srcSegs) || srcSegs.length === 0) return [];
  const total = srcSegs.length;
  const buckets = Math.min(maxBuckets, total);
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const startIdx = Math.floor((b * total) / buckets);
    const endIdx = Math.floor(((b + 1) * total) / buckets);
    const first = srcSegs[startIdx];
    const last = srcSegs[Math.max(startIdx, endIdx - 1)];
    let done = 0;
    let totalLen = 0;
    let speedBps = 0;
    let allCompleted = true;
    let anyDownloading = false;
    let activeIp = '';
    for (let i = startIdx; i < endIdx; i++) {
      const s = srcSegs[i];
      if (s.end >= s.start) {
        totalLen += (s.end - s.start + 1);
      }
      done += Math.max(0, (s.current || s.start) - s.start);
      if (s.status !== 'completed') allCompleted = false;
      if (s.status === 'downloading') {
        anyDownloading = true;
        speedBps += (s.speedBps || 0);
        if (!activeIp && s.ip) activeIp = s.ip;
      }
    }
    const segStart = first.start;
    const segEnd = last.end >= segStart ? (segStart + Math.max(0, totalLen - 1)) : last.end;
    const segStatus = allCompleted ? 'completed' : (anyDownloading ? 'downloading' : 'pending');
    out.push({
      id: idOffset + b,
      start: segStart,
      current: allCompleted && segEnd >= segStart ? (segEnd + 1) : (segStart + done),
      end: segEnd,
      status: segStatus,
      speedBps,
      ip: activeIp,
      retries: 0,
      bytesInWindow: 0
    });
  }
  return out;
}

const YT_PROBE_CACHE = new Map();

/**
 * Duytai v7.5 — 64-Bit Core Engine (TitanFetch Architecture)
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
    this.videoQuality = normalizeVideoQuality(options.videoQuality); // best | 12k | 8k | 4k | 2k | 1080p | 720p | 480p | 360p | audio
    this.maxBytesLimit = options.maxBytesLimit || 0; // Optional cap for partial benchmark tests
    this.allowInsecureTls = Boolean(options.allowInsecureTls);
    this._keepStateOnComplete = Boolean(options._keepStateOnComplete);
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
    this._skipUniqueResolve = Boolean(options._skipUniqueResolve);
    this.filePath = (this._skipUniqueResolve && options.filePath) ? options.filePath : '';
    this.stateFilePath = '';

    this._speedTimer = null;
    this._stateTimer = null;
    this._retryTimers = new Set();
    this._telemetryTick = 0;
    this._ewmaWriteMs = 0;
    this._speedWindow = [];
    this._etaSpeedEwma = 0;
    this._ytSubJobs = [];
    this._ytRunToken = 0;
    this._ytPipelineActive = false;
    this._ytUrlResolvedAt = 0;
    this._ytExpiredRetries = 0;
    this._ytProc = null;
    this._lastCongestionAt = 0;
    this._lastAimdStepAt = 0;
    this._activeHedges = 0;
    this._lastTickBytes = 0;
    this._lastTickTime = 0;
    this._minSplitSize = 512 * 1024; // 512 KB minimum steal size for aggressive tail parallelism
    this._writeBufferSize = 1024 * 1024; // 1 MB write coalescing buffer
    this._globalPendingWriteBytes = 0;
    this._maxGlobalPendingWriteBytes = 128 * 1024 * 1024; // 128 MB per-job write-queue RAM cap (prevents TCP ZeroWindow on 10Gbps)
    this._maxWorkerPendingWriteBytes = 8 * 1024 * 1024; // 8 MB per-worker write-queue cap
    this._savingState = false;
    this._stateSaveQueued = false;
    this._journalLoaded = false;
    this._firstPendingIdx = 0;
  }

  toJSON() {
    const progress = this.totalBytes > 0
      ? Math.min(100, Number(((this.downloadedBytes / this.totalBytes) * 100).toFixed(2)))
      : 0;
    const displaySegs = this.segments.length > 64
      ? summarizeSegments(this.segments, 64, 0)
      : this.segments;
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
      videoQuality: this.videoQuality,
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
      segments: displaySegs.map(s => ({
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
    if (['downloading', 'probing', 'resolving', 'muxing', 'completed'].includes(this.status)) return;
    this.error = null;
    this._rateLimitUntil = 0;
    this._speedWindow = [];
    this._etaSpeedEwma = 0;

    // Fast in-memory resume for active YouTube dual-stream sub-jobs when signed URLs are still fresh (<5h)
    const ytAgeMs = this._ytUrlResolvedAt ? (Date.now() - this._ytUrlResolvedAt) : 0;
    if (this.resolverType === 'youtube' && this._ytPipelineActive && ytAgeMs < 5 * 60 * 60 * 1000 &&
        Array.isArray(this._ytSubJobs) && this._ytSubJobs.length > 0) {
      const unfinished = this._ytSubJobs.filter(s => s && s.status !== 'completed');
      if (unfinished.length > 0) {
        this.status = 'downloading';
        this.startTime = Date.now();
        this.currentSpeedBps = 0;
        this.etaSeconds = null;
        for (const sub of unfinished) {
          sub.error = null;
          sub._rateLimitUntil = 0;
          if (Array.isArray(sub.segments)) {
            for (const seg of sub.segments) {
              seg.retries = 0;
              if (seg.status !== 'completed') seg.status = 'pending';
            }
          }
          sub.start().catch(() => {});
        }
        this.emit('update', this.toJSON());
        return;
      }
    }

    if (Array.isArray(this.segments)) {
      this._firstPendingIdx = 0;
      for (const seg of this.segments) {
        seg.retries = 0;
        seg.bytesInWindow = 0;
        if (typeof seg.committed !== 'number') seg.committed = seg.current;
        if (seg.current <= seg.end || seg.end < 0) {
          seg.status = 'pending';
        }
      }
    }
    this.effectiveMaxConnections = Math.min(this.maxConnections, Math.max(1, this.effectiveMaxConnections || this.maxConnections));
    this._ytExpiredRetries = 0;
    this.status = 'resolving';
    this.emit('update', this.toJSON());

    try {
      await fsp.mkdir(this.saveDir, { recursive: true });

      // 1. Check if URL is a Native HLS (.m3u8) Streaming Playlist
      if (this._isHlsManifestUrl(this.url)) {
        this.resolverType = 'hls';
        this.finalUrl = this.url;
        await this._executeHlsMultiSegmentPipeline();
        return;
      }

      // 2. Check if URL is a YouTube / Social Video Platform URL
      if (this._isYouTubeOrMediaUrl(this.url)) {
        await this._abortYoutubeSubJobs(false);
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

      // 3. Check if URL is a Cloud storage link (Google Drive, Dropbox, OneDrive, MediaFire, GitHub, GitLab, Hugging Face, Archive.org)
      const cloud = await CloudResolver.resolve(this.finalUrl || this.url);
      if (cloud && cloud.url) {
        this.resolverType = cloud.type;
        this.finalUrl = cloud.url;
      }

      this.status = 'probing';
      this.emit('update', this.toJSON());

      if (!this.filePath || this.segments.length === 0) {
        const preProbeUrl = this.finalUrl;
        const [meta] = await Promise.all([
          this._probeUrl(preProbeUrl),
          this._resolveCdnPool(preProbeUrl)
        ]);
        this.finalUrl = meta.finalUrl;
        try {
          if (new URL(this.finalUrl).hostname !== new URL(preProbeUrl).hostname) {
            await this._resolveCdnPool(this.finalUrl);
          }
        } catch {}
        this.totalBytes = this.maxBytesLimit > 0 ? Math.min(meta.totalBytes, this.maxBytesLimit) : meta.totalBytes;
        this.acceptRanges = meta.acceptRanges;
        this.etag = meta.etag;
        this.lastModified = meta.lastModified;
        this.mimeType = meta.mimeType;
        this.serverHeader = meta.serverHeader;

        if (this._isHlsManifestUrl(this.finalUrl) || /mpegurl/i.test(this.mimeType || '')) {
          this.resolverType = 'hls';
          await this._executeHlsMultiSegmentPipeline();
          return;
        }

        const isCurrentGeneric = isGenericFileName(this.fileName);
        if (!this.fileName || isCurrentGeneric) {
          if (meta.fileName && !isGenericFileName(meta.fileName)) {
            this.fileName = meta.fileName;
          } else if (!this.fileName || isCurrentGeneric) {
            this.fileName = meta.fileName || this._inferFileName(this.finalUrl);
          }
        } else if (meta.fileName && !isGenericFileName(meta.fileName) && !path.extname(this.fileName) && path.extname(meta.fileName)) {
          this.fileName = `${this.fileName}${path.extname(meta.fileName)}`;
        }
        if (this._skipUniqueResolve && this.filePath) {
          RESERVED_TARGET_PATHS.set(this.filePath.toLowerCase(), this.id);
        } else {
          this.filePath = await this._resolveUniqueFilePath(path.join(this.saveDir, this.fileName));
        }
        this.fileName = path.basename(this.filePath);
        this.stateFilePath = `${this.filePath}.hyper.json`;

        const resumed = await this._tryLoadStateJournal();
        if (!resumed) {
          this._initializeSegments();
        }
      } else {
        if (!this._journalLoaded && this.stateFilePath && fs.existsSync(this.stateFilePath)) {
          await this._tryLoadStateJournal();
        }
        await this._resolveCdnPool(this.finalUrl);
      }

      const preStat = this.segments.length > 0 && this.segments.every(s => s.status === 'completed') && fs.existsSync(this.filePath)
        ? await fsp.stat(this.filePath).catch(() => null)
        : null;
      if (preStat && (this.totalBytes <= 0 || preStat.size === this.totalBytes)) {
        this.status = 'downloading';
        await this._checkCompletion();
        return;
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
      if (this.status === 'paused' || this.status === 'canceled') return;
      this.status = 'error';
      this.error = err.message || String(err);
      this.currentSpeedBps = 0;
      this.etaSeconds = null;
      await this._abortYoutubeSubJobs(false);
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

  _isHlsManifestUrl(u) {
    return /^https?:\/\/[^?#]+\.m3u8(?:$|[?#])/i.test(String(u || ''));
  }

  _isYouTubeOrMediaUrl(u) {
    return /^https?:\/\/(?:www\.|m\.|vt\.|vm\.)?(?:youtube\.com\/(?:watch|shorts|live)|youtu\.be\/|tiktok\.com\/.+|facebook\.com\/(?:watch|reel|[^/]+\/videos\/)|fb\.watch\/|vimeo\.com\/\d+|bilibili\.com\/video\/|dailymotion\.com\/video\/|twitch\.tv\/videos\/)/i.test(String(u || ''));
  }

  _fetchBuffer(targetUrl, timeoutMs = 15000, redirectCount = 0) {
    if (redirectCount > 8) return Promise.reject(new Error('Too many redirects in HLS fetch'));
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;
    const headers = {
      'User-Agent': this.userAgent,
      'Accept': '*/*',
      'Connection': 'keep-alive',
      ...this.headers
    };
    if (!headers.Referer && !headers.referer) {
      headers['Referer'] = `${parsed.protocol}//${parsed.host}/`;
    }
    return new Promise((resolve, reject) => {
      const req = transport.request(targetUrl, {
        method: 'GET',
        agent: isHttps ? sharedHttpsAgent : sharedHttpAgent,
        headers,
        timeout: timeoutMs,
        rejectUnauthorized: !this.allowInsecureTls
      }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          return this._fetchBuffer(nextUrl, timeoutMs, redirectCount + 1).then(resolve).catch(reject);
        }
        if (code < 200 || code >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${code}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('HLS segment timeout')));
      req.end();
    });
  }

  async _executeHlsMultiSegmentPipeline() {
    this.status = 'probing';
    this.serverHeader = 'Duytai Native HLS 64-Thread Engine';
    this.emit('update', this.toJSON());

    let manifestUrl = this.finalUrl || this.url;
    let manifestText = (await this._fetchBuffer(manifestUrl)).toString('utf8');

    // 1. Resolve Master Playlist (#EXT-X-STREAM-INF) -> pick highest BANDWIDTH variant
    if (manifestText.includes('#EXT-X-STREAM-INF')) {
      const lines = manifestText.split(/\r?\n/);
      let bestBw = -1;
      let bestVariant = '';
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const bwM = /BANDWIDTH=(\d+)/i.exec(line);
          const bw = bwM ? parseInt(bwM[1], 10) : 0;
          for (let j = i + 1; j < lines.length; j++) {
            const nextLine = lines[j].trim();
            if (!nextLine) continue;
            if (!nextLine.startsWith('#')) {
              if (bw >= bestBw) {
                bestBw = bw;
                bestVariant = new URL(nextLine, manifestUrl).toString();
              }
            }
            break;
          }
        }
      }
      if (bestVariant) {
        manifestUrl = bestVariant;
        this.finalUrl = bestVariant;
        manifestText = (await this._fetchBuffer(manifestUrl)).toString('utf8');
      }
    }

    // [VERIFIED-GOLDEN: part5-hls-rfc8216-aes128-ext-x-map | 2026-11-26 | DO NOT MODIFY UNLESS TARGETED]
    // 2. Parse Media Playlist segments, fMP4 init map (#EXT-X-MAP), and AES-128 encryption keys
    const lines = manifestText.split(/\r?\n/);
    const segItems = [];
    let currentKey = null;
    let mediaSequence = 0;
    let mediaIndex = 0;
    let seenInitMapUrl = '';
    const seqM = /#EXT-X-MEDIA-SEQUENCE:(\d+)/i.exec(manifestText);
    if (seqM) mediaSequence = parseInt(seqM[1], 10);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-KEY:')) {
        const methodM = /METHOD=([^,\s]+)/i.exec(line);
        const uriM = /URI="([^"]+)"/i.exec(line);
        const ivM = /IV=0x([0-9a-fA-F]+)/i.exec(line);
        const method = methodM ? methodM[1].toUpperCase() : 'NONE';
        if (method === 'AES-128' && uriM) {
          const keyUrl = new URL(uriM[1], manifestUrl).toString();
          const keyBuf = await this._fetchBuffer(keyUrl);
          const ivHex = ivM ? ivM[1].slice(-32).padStart(32, '0') : '';
          const ivBuf = ivHex ? Buffer.from(ivHex, 'hex') : null;
          currentKey = { keyBuf, ivBuf };
        } else {
          currentKey = null;
        }
        continue;
      }
      if (line.startsWith('#EXT-X-MAP:')) {
        const mapUriM = /URI="([^"]+)"/i.exec(line);
        if (mapUriM) {
          const mapUrl = new URL(mapUriM[1], manifestUrl).toString();
          if (mapUrl !== seenInitMapUrl) {
            seenInitMapUrl = mapUrl;
            // RFC 8216 §4.3.2.5: EXT-X-MAP does NOT increment mediaSequence, and is encrypted ONLY when explicit IV= is present
            segItems.push({
              index: segItems.length,
              seq: -1,
              isInitMap: true,
              url: mapUrl,
              key: (currentKey && currentKey.ivBuf) ? currentKey : null
            });
          }
        }
        continue;
      }
      if (line.startsWith('#')) continue;
      segItems.push({
        index: segItems.length,
        seq: mediaSequence + mediaIndex,
        isInitMap: false,
        url: new URL(line, manifestUrl).toString(),
        key: currentKey
      });
      mediaIndex++;
    }

    if (segItems.length === 0) {
      throw new Error('HLS playlist contains no downloadable media segments');
    }

    if (!this.fileName || isGenericFileName(this.fileName) || /\.m3u8$/i.test(this.fileName)) {
      const base = this._inferFileName(manifestUrl).replace(/\.m3u8$/i, '') || `hls_stream_${Date.now()}`;
      this.fileName = `${base}.mp4`;
    }
    if (!this.filePath) {
      this.filePath = await this._resolveUniqueFilePath(path.join(this.saveDir, this.fileName));
    }
    this.fileName = path.basename(this.filePath);
    const rawTsPath = `${this.filePath}.hls.tmp`;

    this.acceptRanges = true;
    this.status = 'downloading';
    this.startTime = Date.now();
    this._lastTickTime = Date.now();
    this._lastTickBytes = 0;
    this.downloadedBytes = 0;
    this.totalBytes = 0;

    const rawSegments = segItems.map((it, idx) => ({
      id: idx,
      start: idx * 100,
      current: idx * 100,
      end: idx * 100 + 99,
      status: 'pending',
      speedBps: 0,
      ip: '',
      retries: 0,
      bytesInWindow: 0
    }));
    const updateHlsProgress = () => {
      this.segments = summarizeSegments(rawSegments, 64, 0);
    };
    updateHlsProgress();
    this.emit('update', this.toJSON());

    const outHandle = await fsp.open(rawTsPath, 'w');
    const reorderBuffer = new Map();
    let nextWriteIndex = 0;
    let completedCount = 0;
    let cursor = 0;
    let fatalErr = null;
    const concurrency = Math.min(this.maxConnections || 64, 64, segItems.length);

    const decryptIfNeeded = (buf, item) => {
      if (!item.key || !item.key.keyBuf || item.key.keyBuf.length !== 16) return buf;
      let iv = item.key.ivBuf;
      if (!iv) {
        iv = Buffer.alloc(16, 0);
        iv.writeBigUInt64BE(BigInt(Math.max(0, item.seq)), 8);
      }
      const decipher = crypto.createDecipheriv('aes-128-cbc', item.key.keyBuf, iv);
      return Buffer.concat([decipher.update(buf), decipher.final()]);
    };

    let flushChain = Promise.resolve();
    const flushOrderedChunks = () => {
      flushChain = flushChain.then(async () => {
        while (reorderBuffer.has(nextWriteIndex)) {
          const chunk = reorderBuffer.get(nextWriteIndex);
          reorderBuffer.delete(nextWriteIndex);
          await outHandle.write(chunk);
          nextWriteIndex++;
        }
      });
      return flushChain;
    };

    const hlsSpeedTimer = setInterval(() => {
      if (this.status !== 'downloading') return;
      const now = Date.now();
      const dt = Math.max(0.1, (now - this._lastTickTime) / 1000);
      const dBytes = Math.max(0, this.downloadedBytes - this._lastTickBytes);
      this.currentSpeedBps = Math.round(dBytes / dt);
      if (this.currentSpeedBps > this.peakSpeedBps) this.peakSpeedBps = this.currentSpeedBps;
      this._lastTickTime = now;
      this._lastTickBytes = this.downloadedBytes;
      if (completedCount > 0) {
        const avgSegSize = this.downloadedBytes / completedCount;
        this.totalBytes = Math.round(avgSegSize * segItems.length);
        if (this.currentSpeedBps > 0) {
          this.etaSeconds = Math.ceil(Math.max(0, this.totalBytes - this.downloadedBytes) / this.currentSpeedBps);
        }
      }
      updateHlsProgress();
      this.emit('update', this.toJSON());
    }, 500);

    try {
      const workers = Array.from({ length: concurrency }, async () => {
        while (!fatalErr && this.status === 'downloading') {
          const idx = cursor++;
          if (idx >= segItems.length) break;
          const item = segItems[idx];
          const segState = rawSegments[idx];
          segState.status = 'downloading';

          // Backpressure guard: if out-of-order buffer holds > 96 segments, pause worker briefly
          while (idx - nextWriteIndex > 96 && !fatalErr && this.status === 'downloading') {
            await new Promise(r => setTimeout(r, 40));
          }

          let success = false;
          for (let attempt = 0; attempt < 6; attempt++) {
            if (fatalErr || this.status !== 'downloading') break;
            try {
              const rawBuf = await this._fetchBuffer(item.url, 15000);
              const plainBuf = decryptIfNeeded(rawBuf, item);
              reorderBuffer.set(idx, plainBuf);
              await flushOrderedChunks();
              this.downloadedBytes += plainBuf.length;
              completedCount++;
              segState.current = segState.end + 1;
              segState.status = 'completed';
              success = true;
              break;
            } catch (e) {
              if (attempt === 5) fatalErr = e;
              else await new Promise(r => setTimeout(r, 150 * (attempt + 1)));
            }
          }
          if (!success && !fatalErr) fatalErr = new Error(`Failed HLS segment #${idx}`);
        }
      });

      await Promise.all(workers);
      await flushOrderedChunks();
    } finally {
      clearInterval(hlsSpeedTimer);
      reorderBuffer.clear();
      await outHandle.close().catch(() => {});
    }

    if (this.status === 'paused' || this.status === 'canceled') {
      if (this.status === 'canceled') {
        await fsp.unlink(rawTsPath).catch(() => {});
      }
      return;
    }
    if (fatalErr) {
      await fsp.unlink(rawTsPath).catch(() => {});
      throw fatalErr;
    }

    // 3. Remux concatenated TS/fMP4 stream into clean MP4 container via FFmpeg -c copy if targeting .mp4
    const ffmpeg = findBinary('ffmpeg.exe');
    if (ffmpeg && this.filePath.toLowerCase().endsWith('.mp4')) {
      this.status = 'muxing';
      this.currentSpeedBps = 0;
      this.emit('update', this.toJSON());
      const muxedOk = await new Promise((resolve) => {
        try {
          execFile(ffmpeg, ['-y', '-loglevel', 'error', '-i', rawTsPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', this.filePath], {
            maxBuffer: 16 * 1024 * 1024,
            timeout: 120000
          }, (err) => resolve(!err && fs.existsSync(this.filePath)));
        } catch {
          resolve(false);
        }
      });
      if (muxedOk) {
        await fsp.unlink(rawTsPath).catch(() => {});
      } else {
        await fsp.rename(rawTsPath, this.filePath).catch(() => {});
      }
    } else {
      await fsp.rename(rawTsPath, this.filePath).catch(() => {});
    }
    // [/VERIFIED-GOLDEN]

    const st = await fsp.stat(this.filePath).catch(() => null);
    if (st) {
      this.totalBytes = st.size;
      this.downloadedBytes = st.size;
    }
    updateHlsProgress();
    this.status = 'completed';
    this.endTime = Date.now();
    this.elapsedMs = this.endTime - this.startTime;
    this.currentSpeedBps = 0;
    this.etaSeconds = 0;
    this.emit('update', this.toJSON());
    this.emit('completed', this.toJSON());
  }

  async _abortYoutubeSubJobs(deleteFiles = false) {
    this._ytRunToken++;
    this._ytPipelineActive = false;
    if (this._ytProc) {
      try { this._ytProc.kill(); } catch {}
      this._ytProc = null;
    }
    const subs = Array.isArray(this._ytSubJobs) ? this._ytSubJobs.slice() : [];
    this._ytSubJobs = [];
    for (const sub of subs) {
      if (!sub) continue;
      if (sub._parentSyncListener) {
        sub.removeListener('update', sub._parentSyncListener);
        sub._parentSyncListener = null;
      }
      try {
        await sub.cancel(Boolean(deleteFiles));
      } catch {}
    }
    if (deleteFiles && this.filePath) {
      const stalePaths = [
        `${this.filePath}.video.tmp`,
        `${this.filePath}.video.tmp.hyper.json`,
        `${this.filePath}.audio.tmp`,
        `${this.filePath}.audio.tmp.hyper.json`
      ];
      for (const p of stalePaths) {
        if (fs.existsSync(p)) {
          await fsp.unlink(p).catch(() => {});
        }
      }
    }
  }

  async _executeYouTubeMultiStreamPipeline() {
    const runToken = ++this._ytRunToken;
    const ytdlp = findBinary('yt-dlp.exe');
    const ffmpeg = findBinary('ffmpeg.exe');

    // Choose optimal high-speed direct HTTPS byte-range formats (avoids slow HLS m3u8 playlists)
    this.videoQuality = normalizeVideoQuality(this.videoQuality);
    const formatSelector = YT_QUALITY_FORMATS[this.videoQuality] || YT_QUALITY_FORMATS.best;

    const info = await new Promise((resolve, reject) => {
      const child = execFile(ytdlp, ['--no-warnings', '--no-playlist', '-f', formatSelector, '--dump-single-json', this.url], {
        maxBuffer: 32 * 1024 * 1024
      }, (err, stdout, stderr) => {
        if (this._ytProc === child) this._ytProc = null;
        if (this._ytRunToken !== runToken || this.status === 'paused' || this.status === 'canceled') {
          return resolve(null);
        }
        if (err) return reject(new Error(stderr || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Cannot parse YouTube stream metadata: ${e.message}`));
        }
      });
      this._ytProc = child;
    });

    if (!info || this._ytRunToken !== runToken || this.status === 'paused' || this.status === 'canceled') {
      return;
    }

    const formats = Array.isArray(info.requested_formats) && info.requested_formats.length > 0
      ? info.requested_formats
      : [{ url: info.url, filesize: info.filesize || info.filesize_approx || 0, ext: info.ext || (this.videoQuality === 'audio' ? 'm4a' : 'mp4') }];

    const isAudioOnly = this.videoQuality === 'audio';
    const targetExt = isAudioOnly ? `.${String(formats[0].ext || 'm4a').replace(/^\./, '').toLowerCase()}` : '.mp4';
    const cleanTitle = this._sanitizeFileName(info.title || `youtube_${info.id || Date.now()}`);
    if (!this.fileName) {
      this.fileName = `${cleanTitle}${targetExt}`;
    } else if (isAudioOnly && this.fileName.toLowerCase().endsWith('.mp4')) {
      this.fileName = `${this.fileName.slice(0, -4)}${targetExt}`;
    } else if (!this.fileName.toLowerCase().endsWith(targetExt) && !/\.(mp4|mkv|webm|m4a|mp3)$/i.test(this.fileName)) {
      this.fileName = `${this.fileName}${targetExt}`;
    }

    if (!this.filePath || fs.existsSync(this.filePath)) {
      this.filePath = await this._resolveUniqueFilePath(path.join(this.saveDir, this.fileName));
    }
    this.fileName = path.basename(this.filePath);
    this.serverHeader = 'YouTube Googlevideo Multi-Range Engine';
    this.startTime = Date.now();

    if (formats.length === 1) {
      this.finalUrl = formats[0].url;
      this.stateFilePath = `${this.filePath}.hyper.json`;
      const meta = await this._probeUrl(this.finalUrl);
      if (this._ytRunToken !== runToken || this.status === 'paused' || this.status === 'canceled') return;
      this.totalBytes = meta.totalBytes;
      this.acceptRanges = meta.acceptRanges;
      await this._resolveCdnPool(this.finalUrl);
      if (this._ytRunToken !== runToken || this.status === 'paused' || this.status === 'canceled') return;
      const resumed = await this._tryLoadStateJournal();
      if (!resumed) {
        this._initializeSegments();
      }
      const preStat = this.segments.length > 0 && this.segments.every(s => s.status === 'completed') && fs.existsSync(this.filePath)
        ? await fsp.stat(this.filePath).catch(() => null)
        : null;
      if (preStat && (this.totalBytes <= 0 || preStat.size === this.totalBytes)) {
        this.status = 'downloading';
        await this._checkCompletion();
        return;
      }

      await this._openAndPreallocateTargetFile();
      if (this._ytRunToken !== runToken || this.status === 'paused' || this.status === 'canceled') {
        await this._cleanupHandles();
        return;
      }
      this.status = 'downloading';
      this._lastTickTime = Date.now();
      this._lastTickBytes = this.downloadedBytes;
      this._startTelemetryLoop();
      this._scheduleWorkers();
      this.emit('update', this.toJSON());
      return;
    }

    this._ytUrlResolvedAt = Date.now();
    if (this.filePath) RESERVED_TARGET_PATHS.set(this.filePath.toLowerCase(), this.id);

    // Dual Parallel 64-Thread Engine for Video Track + Audio Track -> Fast FFmpeg Copy Mux
    const vTrack = formats[0];
    const aTrack = formats[1];
    const vTempPath = `${this.filePath}.video.tmp`;
    const aTempPath = `${this.filePath}.audio.tmp`;

    const vJob = new DownloadJob({
      url: vTrack.url,
      saveDir: this.saveDir,
      fileName: path.basename(vTempPath),
      filePath: vTempPath,
      _skipUniqueResolve: true,
      _keepStateOnComplete: true,
      allowInsecureTls: this.allowInsecureTls,
      maxConnections: Math.max(16, Math.floor(this.maxConnections * 0.75))
    });
    const aJob = new DownloadJob({
      url: aTrack.url,
      saveDir: this.saveDir,
      fileName: path.basename(aTempPath),
      filePath: aTempPath,
      _skipUniqueResolve: true,
      _keepStateOnComplete: true,
      allowInsecureTls: this.allowInsecureTls,
      maxConnections: Math.max(8, Math.floor(this.maxConnections * 0.25))
    });

    this._ytSubJobs = [vJob, aJob];
    this._ytPipelineActive = true;
    this.status = 'downloading';
    let lastSyncEmitAt = 0;

    const syncSubJobs = (forceEmit = false) => {
      if (runToken !== this._ytRunToken || !this._ytPipelineActive) return;
      if (this.status !== 'downloading' && this.status !== 'resolving' && this.status !== 'probing') return;

      const now = Date.now();
      if (!forceEmit && (now - lastSyncEmitAt) < 450) return;
      lastSyncEmitAt = now;

      this.totalBytes = (vJob.totalBytes || vTrack.filesize || 0) + (aJob.totalBytes || aTrack.filesize || 0);
      this.downloadedBytes = (vJob.downloadedBytes || 0) + (aJob.downloadedBytes || 0);
      this.currentSpeedBps = (vJob.currentSpeedBps || 0) + (aJob.currentSpeedBps || 0);
      if (this.currentSpeedBps > this.peakSpeedBps) this.peakSpeedBps = this.currentSpeedBps;
      if (vJob.acceptRanges || aJob.acceptRanges) this.acceptRanges = true;
      this.stealCount = (vJob.stealCount || 0) + (aJob.stealCount || 0);
      this.recycleCount = (vJob.recycleCount || 0) + (aJob.recycleCount || 0);
      this.cdnIps = Array.from(new Set([...(vJob.cdnIps || []), ...(aJob.cdnIps || [])]));

      // Aggregate 5,000+ micro-chunks evenly into <= 64 crisp progress segments
      this.segments = [
        ...summarizeSegments(vJob.segments, 48, 0),
        ...summarizeSegments(aJob.segments, 16, 48)
      ];

      if (this.currentSpeedBps > 0) {
        this._etaSpeedEwma = this._etaSpeedEwma > 0
          ? Math.round(this._etaSpeedEwma * 0.78 + this.currentSpeedBps * 0.22)
          : this.currentSpeedBps;
      }
      if (this.totalBytes > 0 && this._etaSpeedEwma > 0) {
        this.etaSeconds = Math.ceil(Math.max(0, this.totalBytes - this.downloadedBytes) / this._etaSpeedEwma);
      } else {
        this.etaSeconds = null;
      }
      this.emit('update', this.toJSON());
    };

    vJob._parentSyncListener = () => syncSubJobs(false);
    aJob._parentSyncListener = () => syncSubJobs(false);
    vJob.on('update', vJob._parentSyncListener);
    aJob.on('update', aJob._parentSyncListener);

    try {
      await Promise.all([
        new Promise((res, rej) => {
          vJob.on('completed', res);
          vJob.on('update', s => { if (s.status === 'error') rej(new Error(s.error || 'Video stream failed')); });
          vJob.start();
        }),
        new Promise((res, rej) => {
          aJob.on('completed', res);
          aJob.on('update', s => { if (s.status === 'error') rej(new Error(s.error || 'Audio stream failed')); });
          aJob.start();
        })
      ]);
    } catch (subErr) {
      if (this._ytRunToken === runToken && this.status === 'downloading' &&
          this._ytExpiredRetries < 1 && /HTTP (403|410)\b/i.test(subErr.message || '')) {
        this._ytExpiredRetries++;
        await Promise.all([vJob.pause().catch(() => {}), aJob.pause().catch(() => {})]);
        this._ytPipelineActive = false;
        this._ytSubJobs = [];
        return this._executeYouTubeMultiStreamPipeline();
      }
      throw subErr;
    } finally {
      if (this._ytRunToken === runToken) {
        this._ytPipelineActive = false;
      }
      if (vJob._parentSyncListener) { vJob.removeListener('update', vJob._parentSyncListener); vJob._parentSyncListener = null; }
      if (aJob._parentSyncListener) { aJob.removeListener('update', aJob._parentSyncListener); aJob._parentSyncListener = null; }
    }

    if (this._ytRunToken !== runToken || this.status === 'canceled' || this.status === 'paused') {
      return;
    }

    this.status = 'muxing';
    this.currentSpeedBps = 0;
    this.etaSeconds = null;
    this.emit('update', this.toJSON());

    const totalMuxBytes = (vJob.totalBytes || 0) + (aJob.totalBytes || 0);
    const ffArgs = [
      '-y',
      '-loglevel', 'error',
      '-i', vJob.filePath,
      '-i', aJob.filePath,
      '-c:v', 'copy',
      '-c:a', 'copy'
    ];
    // For <= 2 GB MP4, relocate moov atom for instant web playback; skip 2nd pass on > 2 GB files to avoid 2x SSD rewrite
    if (totalMuxBytes > 0 && totalMuxBytes <= 2 * 1024 * 1024 * 1024) {
      ffArgs.push('-movflags', '+faststart');
    }
    ffArgs.push(this.filePath);

    await new Promise((resolve, reject) => {
      if (this._ytRunToken !== runToken || this.status === 'canceled') return resolve();
      const child = execFile(ffmpeg, ffArgs, { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (this._ytProc === child) this._ytProc = null;
        if (this._ytRunToken !== runToken || this.status === 'canceled') return resolve();
        if (err) return reject(new Error(`FFmpeg mux error: ${stderr || err.message}`));
        resolve();
      });
      this._ytProc = child;
    });

    if (this._ytRunToken !== runToken || this.status === 'canceled') {
      return;
    }

    this._ytSubJobs = [];
    for (const p of [vJob.filePath, `${vJob.filePath}.hyper.json`, aJob.filePath, `${aJob.filePath}.hyper.json`]) {
      if (p) await fsp.unlink(p).catch(() => {});
    }

    const finalStat = await fsp.stat(this.filePath).catch(() => null);
    if (finalStat) {
      this.totalBytes = finalStat.size;
      this.downloadedBytes = finalStat.size;
    }

    this.status = 'completed';
    this.endTime = Date.now();
    this.elapsedMs = this.endTime - this.startTime;
    this.currentSpeedBps = 0;
    this._speedWindow = [];
    this._etaSpeedEwma = 0;
    this._activeHedges = 0;
    this.etaSeconds = 0;
    this.emit('update', this.toJSON());
    this.emit('completed', this.toJSON());
  }

  async pause() {
    if (!['downloading', 'probing', 'resolving'].includes(this.status)) return;
    const wasResolvingPreSubJobs = this.resolverType === 'youtube' && (!this._ytSubJobs || this._ytSubJobs.length === 0);
    if (wasResolvingPreSubJobs) {
      this._ytRunToken++;
    }
    this.status = 'paused';
    if (this.startTime) {
      this.elapsedMs += Date.now() - this.startTime;
      this.startTime = 0;
    }
    this.currentSpeedBps = 0;
    this._speedWindow = [];
    this._etaSpeedEwma = 0;
    this.etaSeconds = null;
    this._activeHedges = 0;

    if (this._ytProc) {
      try { this._ytProc.kill(); } catch {}
      this._ytProc = null;
    }

    if (this._ytSubJobs && this._ytSubJobs.length > 0) {
      await Promise.all(this._ytSubJobs.map(j => j.pause().catch(() => {})));
      let sumDl = 0;
      let sumTot = 0;
      for (const j of this._ytSubJobs) {
        sumDl += (j.downloadedBytes || 0);
        sumTot += (j.totalBytes || 0);
      }
      if (sumTot > 0) this.totalBytes = sumTot;
      if (sumDl > 0) this.downloadedBytes = sumDl;
      const vJob = this._ytSubJobs[0];
      const aJob = this._ytSubJobs[1];
      this.segments = [
        ...summarizeSegments(vJob ? vJob.segments : [], aJob ? 48 : 64, 0),
        ...(aJob ? summarizeSegments(aJob.segments, 16, 48) : [])
      ];
      this.currentSpeedBps = 0;
      this.etaSeconds = null;
      this.emit('update', this.toJSON());
      return;
    }

    await this._abortAllWorkers();
    await this._saveStateJournal();
    await this._cleanupHandles();
    this.emit('update', this.toJSON());
  }

  async restart() {
    if (!/^https?:\/\//i.test(this.url || '')) {
      throw new Error('Không thể tải lại từ đầu khi chưa có URL HTTP/HTTPS hợp lệ');
    }
    this.status = 'paused';
    if (this._rateLimitTimer) {
      clearTimeout(this._rateLimitTimer);
      this._rateLimitTimer = null;
    }
    await this._abortYoutubeSubJobs(true);
    await this._abortAllWorkers();
    await this._cleanupHandles();

    const oldFilePath = this.filePath;
    const oldStatePath = this.stateFilePath || (oldFilePath ? `${oldFilePath}.hyper.json` : '');
    if (oldFilePath && fs.existsSync(oldFilePath)) {
      await fsp.unlink(oldFilePath).catch(() => {});
    }
    if (oldStatePath && fs.existsSync(oldStatePath)) {
      await fsp.unlink(oldStatePath).catch(() => {});
    }

    this.error = null;
    this.finalUrl = this.url;
    this.downloadedBytes = 0;
    this.totalBytes = 0;
    this.acceptRanges = false;
    this.startTime = 0;
    this.endTime = 0;
    this.elapsedMs = 0;
    this.currentSpeedBps = 0;
    this.peakSpeedBps = 0;
    this.etaSeconds = null;
    this._etaSpeedEwma = 0;
    this.speedHistory = [];
    this.stealCount = 0;
    this.recycleCount = 0;
    this.hedgeWins = 0;
    this.segments = [];
    this.activeWorkers.clear();
    this._badIps.clear();
    this._ipStats.clear();
    this._ewmaWriteMs = 0;
    this.filePath = '';
    this.stateFilePath = '';
    this._lastTickBytes = 0;
    this._lastTickTime = 0;
    this._lastCongestionAt = 0;
    this._lastAimdStepAt = 0;
    this._globalPendingWriteBytes = 0;
    this._rateLimitUntil = 0;
    this.effectiveMaxConnections = this.maxConnections;
    this.status = 'queued';

    this.emit('update', this.toJSON());
    this.start().catch(() => {});
  }

  async cancel(deleteFile = true, options = {}) {
    this.status = 'canceled';
    this.currentSpeedBps = 0;
    this._speedWindow = [];
    this._etaSpeedEwma = 0;
    this.etaSeconds = null;
    this._activeHedges = 0;
    await this._abortYoutubeSubJobs(false);
    await this._abortAllWorkers();
    await this._cleanupHandles();

    const baseFile = this.filePath || (this.saveDir && this.fileName ? path.join(this.saveDir, this.fileName) : '');
    const journalsToDelete = [
      this.stateFilePath,
      baseFile ? `${baseFile}.hyper.json` : '',
      baseFile ? `${baseFile}.video.tmp.hyper.json` : '',
      baseFile ? `${baseFile}.audio.tmp.hyper.json` : ''
    ].filter(Boolean);

    if (deleteFile) {
      const filesToRemove = [
        baseFile,
        baseFile ? `${baseFile}.video.tmp` : '',
        baseFile ? `${baseFile}.audio.tmp` : ''
      ].filter(p => p && fs.existsSync(p));

      if (filesToRemove.length > 0) {
        if (options && typeof options.moveToTrashFn === 'function') {
          await options.moveToTrashFn(filesToRemove).catch(async () => {
            for (const p of filesToRemove) await fsp.unlink(p).catch(() => {});
          });
        } else {
          for (const p of filesToRemove) {
            await fsp.unlink(p).catch(() => {});
          }
        }
      }
      for (const jp of journalsToDelete) {
        if (fs.existsSync(jp)) await fsp.unlink(jp).catch(() => {});
      }
    } else if (this.status !== 'completed') {
      for (const jp of journalsToDelete) {
        if (fs.existsSync(jp)) await fsp.unlink(jp).catch(() => {});
      }
    }
    this.emit('update', this.toJSON());
  }

  async _probeUrl(targetUrl, redirectCount = 0) {
    if (redirectCount > 10) throw new Error('Too many redirects');
    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const probeHeaders = {
      'User-Agent': this.userAgent,
      'Accept': '*/*',
      'Range': 'bytes=0-0',
      'Connection': 'keep-alive',
      ...this.headers
    };
    if (!probeHeaders.Referer && !probeHeaders.referer) {
      try { const p = new URL(targetUrl); probeHeaders['Referer'] = `${p.protocol}//${p.host}/`; } catch (_) {}
    }
    if (!probeHeaders.Origin && !probeHeaders.origin) {
      try { const p = new URL(targetUrl); probeHeaders['Origin'] = `${p.protocol}//${p.host}`; } catch (_) {}
    }

    return new Promise((resolve, reject) => {
      const req = transport.request(targetUrl, {
        method: 'GET',
        agent: isHttps ? sharedHttpsAgent : sharedHttpAgent,
        headers: probeHeaders,
        timeout: 15000,
        rejectUnauthorized: !this.allowInsecureTls
      }, (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          const setCookie = res.headers['set-cookie'];
          if (setCookie && Array.isArray(setCookie)) {
            const newCookies = setCookie.map(c => c.split(';')[0]).join('; ');
            this.headers = this.headers || {};
            this.headers.Cookie = this.headers.Cookie ? `${this.headers.Cookie}; ${newCookies}` : newCookies;
          }
          this._probeUrl(nextUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }

        const contentType = (res.headers['content-type'] || '').toLowerCase();
        const isHtml = contentType.includes('text/html');
        if (code === 200 && isHtml && redirectCount < 8) {
          let bodyBuf = '';
          res.on('data', chunk => {
            if (bodyBuf.length < 65536) bodyBuf += chunk.toString();
          });
          res.on('end', () => {
            let nextTargetUrl = '';

            // A) Google Drive virus warning confirmation
            if (/drive\.(?:usercontent\.)?google\.com/i.test(targetUrl)) {
              const linkMatch = /href="([^"]*(?:confirm=[a-zA-Z0-9_-]+|uuid=[a-zA-Z0-9_-]+)[^"]*)"/i.exec(bodyBuf) ||
                                /action="([^"]+)"/i.exec(bodyBuf);
              if (linkMatch) {
                let rawLink = linkMatch[1].replace(/&amp;/g, '&');
                if (rawLink.startsWith('/')) {
                  const u = new URL(targetUrl);
                  nextTargetUrl = `${u.protocol}//${u.host}${rawLink}`;
                } else if (/^https?:\/\//i.test(rawLink)) {
                  nextTargetUrl = rawLink;
                }
                const idM = /name="id"\s+value="([^"]+)"/i.exec(bodyBuf);
                const exportM = /name="export"\s+value="([^"]+)"/i.exec(bodyBuf);
                const confirmM = /name="confirm"\s+value="([^"]+)"/i.exec(bodyBuf);
                const uuidM = /name="uuid"\s+value="([^"]+)"/i.exec(bodyBuf);
                if (idM && confirmM) {
                  const u = new URL(nextTargetUrl || 'https://drive.usercontent.google.com/download');
                  u.searchParams.set('id', idM[1]);
                  u.searchParams.set('export', exportM ? exportM[1] : 'download');
                  u.searchParams.set('confirm', confirmM[1]);
                  if (uuidM) u.searchParams.set('uuid', uuidM[1]);
                  nextTargetUrl = u.toString();
                }
              }
            }

            // B) Universal HTML Landing Page File Link Extractor (Meta refresh or Direct Download button)
            if (!nextTargetUrl) {
              const metaRefresh = /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?[^;]+;\s*url=([^"'>\s]+)["']?/i.exec(bodyBuf);
              if (metaRefresh && /^https?:\/\//i.test(metaRefresh[1])) {
                nextTargetUrl = metaRefresh[1];
              }
            }
            if (!nextTargetUrl) {
              const buttonMatch = /id=["']downloadButton["'][^>]*href=["']([^"']+)["']/i.exec(bodyBuf) ||
                                  /class=["'][^"']*(?:btn-download|download-btn|download_button)[^"']*["'][^>]*href=["']([^"']+)["']/i.exec(bodyBuf) ||
                                  /href=["'](https?:\/\/[^"']+\.(?:zip|rar|7z|bin|iso|exe|msi|dmg|pkg|apk|pdf|docx|xlsx|tar|gz|ubi|ipsw|mp4|mkv|webm)(?:\?[^"']*)?)["']/i.exec(bodyBuf);
              if (buttonMatch && /^https?:\/\//i.test(buttonMatch[1])) {
                nextTargetUrl = buttonMatch[1];
              }
            }

            if (nextTargetUrl) {
              const setCookie = res.headers['set-cookie'];
              if (setCookie && Array.isArray(setCookie)) {
                const newCookies = setCookie.map(c => c.split(';')[0]).join('; ');
                this.headers = this.headers || {};
                this.headers.Cookie = this.headers.Cookie ? `${this.headers.Cookie}; ${newCookies}` : newCookies;
              }
              this._probeUrl(nextTargetUrl, redirectCount + 1).then(resolve).catch(reject);
              return;
            }

            resolve({
              finalUrl: targetUrl,
              totalBytes: 0,
              acceptRanges: false,
              etag: res.headers['etag'] || '',
              lastModified: res.headers['last-modified'] || '',
              mimeType: contentType,
              serverHeader: res.headers['server'] || 'Web',
              fileName: ''
            });
          });
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
        const fnStar = /filename\*=(?:UTF-8|utf-8|ISO-8859-1|US-ASCII)?''"?([^";\r\n]+)"?/i.exec(cd);
        const fnPlain = /filename="?([^";\r\n]+)"?/i.exec(cd);
        if (fnStar) {
          try { fileName = decodeURIComponent(fnStar[1]); } catch { fileName = fnStar[1]; }
        } else if (fnPlain) {
          fileName = fnPlain[1].trim();
        }
        fileName = decodeRfc2047(fileName).replace(/^["']|["']$/g, '').trim();

        // Zero-RTT Warm Socket Reuse: for 1-byte HTTP 206 probe, drain 1 byte so Keep-Alive Agent parks the warm TLS socket in LIFO pool for Worker #0
        if (code === 206) {
          try { res.resume(); } catch {}
        } else {
          try { res.destroy(); } catch {}
          try { req.destroy(); } catch {}
        }

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
      const cleanHost = parsed.hostname.replace(/^\[|\]$/g, '');
      if (netIsIp(cleanHost) || cleanHost.toLowerCase() === 'localhost') {
        this.cdnIps = [cleanHost];
        return;
      }
      const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
      const cacheKey = `${parsed.hostname}:${port}`;
      const cached = DNS_POOL_CACHE.get(cacheKey);
      if (cached && cached.expiresAt > Date.now() && cached.ips.length > 0) {
        this.cdnIps = cached.ips.slice();
        return;
      }

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

      let pool = unique.size > 0 ? Array.from(unique) : [parsed.hostname];
      if (pool.length > 1) {
        const probeTargets = pool.slice(0, 8);
        const latResults = await Promise.all(probeTargets.map(async (ip) => ({
          ip,
          rtt: await probeTcpLatency(ip, port, 350)
        })));
        latResults.sort((a, b) => a.rtt - b.rtt);
        const sortedSet = new Set(latResults.map(r => r.ip));
        pool = [...latResults.map(r => r.ip), ...pool.filter(ip => !sortedSet.has(ip))];
      }

      if (DNS_POOL_CACHE.size >= 200) {
        const firstKey = DNS_POOL_CACHE.keys().next().value;
        if (firstKey !== undefined) DNS_POOL_CACHE.delete(firstKey);
      }
      DNS_POOL_CACHE.set(cacheKey, { ips: pool.slice(), expiresAt: Date.now() + DNS_POOL_TTL_MS });
      this.cdnIps = pool;
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
        committed: 0,
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
    if (this.totalBytes < 256 * 1024) smartCap = 1;
    else if (this.totalBytes < 2 * 1024 * 1024) smartCap = Math.min(this.maxConnections, 16);
    else if (this.totalBytes < 16 * 1024 * 1024) smartCap = Math.min(this.maxConnections, 32);
    this._targetMaxConnections = Math.max(1, smartCap);
    this.effectiveMaxConnections = this._targetMaxConnections;

    // For googlevideo.com, slice into bounded range chunks (2MB..8MB) to bypass YouTube per-connection throttling without segment bloat
    const isGoogleVideo = this.finalUrl.includes('googlevideo.com');
    if (isGoogleVideo && this.totalBytes > 2 * 1024 * 1024) {
      const microSize = Math.max(2 * 1024 * 1024, Math.min(8 * 1024 * 1024, Math.ceil(this.totalBytes / 1024)));
      const numChunks = Math.ceil(this.totalBytes / microSize);
      this._firstPendingIdx = 0;
      for (let i = 0; i < numChunks; i++) {
        const start = i * microSize;
        const end = Math.min(this.totalBytes - 1, (i + 1) * microSize - 1);
        this.segments.push({
          id: i,
          start,
          current: start,
          committed: start,
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

    this._firstPendingIdx = 0;
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
        committed: start,
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
    if (this.fileHandle) {
      try { await this.fileHandle.close(); } catch {}
      this.fileHandle = null;
    }
    const exists = fs.existsSync(this.filePath);
    this.fileHandle = await fsp.open(this.filePath, exists ? 'r+' : 'w+');

    if (!exists && this.totalBytes > 0) {
      if (process.platform === 'win32') {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 250);
          try {
            execFile('fsutil', ['sparse', 'setflag', this.filePath], () => {
              clearTimeout(t);
              resolve();
            });
          } catch {
            clearTimeout(t);
            resolve();
          }
        });
      }
      try {
        await this.fileHandle.truncate(this.totalBytes);
      } catch {}
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
    let spawnedThisWave = 0;
    const waveBatch = 64;
    let hasMorePending = false;

    for (const seg of this.segments) {
      if (seg.status === 'pending') {
        if (this.activeWorkers.size < connLimit && spawnedThisWave < waveBatch) {
          this._spawnWorker(seg);
          spawnedThisWave++;
        } else if (this.activeWorkers.size < connLimit) {
          hasMorePending = true;
        }
      }
    }

    if (hasMorePending && this.status === 'downloading') {
      setTimeout(() => {
        if (this.status === 'downloading') this._scheduleWorkers();
      }, 15).unref?.();
    }

    while (!hasMorePending && this.acceptRanges && this.activeWorkers.size < connLimit) {
      const stolenSeg = this._tryStealFromLargestSegment();
      if (!stolenSeg) break;
      this._spawnWorker(stolenSeg);
    }

    this._checkCompletion();
  }

  _compactCompletedSegments() {
    if (!Array.isArray(this.segments) || this.segments.length < 64) return;
    const sorted = this.segments.slice().sort((a, b) => a.start - b.start);
    const compacted = [];
    for (const seg of sorted) {
      const prev = compacted[compacted.length - 1];
      if (prev && prev.status === 'completed' && seg.status === 'completed' &&
          !this.activeWorkers.has(prev.id) && !this.activeWorkers.has(seg.id) &&
          (prev.end + 1 === seg.start)) {
        prev.end = seg.end;
        prev.current = Math.max(prev.current, seg.current);
        prev.committed = Math.max(prev.committed || prev.current, seg.committed || seg.current);
      } else {
        compacted.push(seg);
      }
    }
    if (compacted.length < this.segments.length) {
      this.segments = compacted;
    }
  }

  _tryStealFromLargestSegment() {
    const isTailPhase = this.totalBytes > 0 && (this.downloadedBytes / this.totalBytes) > 0.75;
    const isFinalPhase = this.totalBytes > 0 && (this.downloadedBytes / this.totalBytes) > 0.92;
    const isEndSprint = this.totalBytes > 0 && (this.downloadedBytes / this.totalBytes) > 0.98;
    const isHugeFile = this.totalBytes > 2 * 1024 * 1024 * 1024;
    if (this.segments.length >= 1024) {
      this._compactCompletedSegments();
      if (this.segments.length >= 1024) return null;
    }
    const minSplit = isEndSprint
      ? (64 * 1024)
      : (isHugeFile
        ? (isFinalPhase ? (256 * 1024) : (isTailPhase ? (1024 * 1024) : (2 * 1024 * 1024)))
        : (isFinalPhase ? (128 * 1024) : (isTailPhase ? (256 * 1024) : this._minSplitSize)));

    let largest = null;
    let maxRemaining = 0;
    let maxScore = -1;

    for (const seg of this.segments) {
      if (seg.status === 'downloading' && seg.end > seg.current) {
        const remaining = seg.end - seg.current + 1;
        if (remaining < minSplit * 2) continue;
        // Prioritize slow bottleneck segments with high estimated remaining time (ETA-weighted work-stealing)
        const effSpeed = (seg.speedBps && seg.speedBps > 0) ? Math.max(32 * 1024, seg.speedBps) : (512 * 1024);
        const score = isTailPhase ? (remaining / effSpeed) : remaining;
        if (score > maxScore) {
          maxScore = score;
          maxRemaining = remaining;
          largest = seg;
        }
      }
    }

    if (!largest || maxRemaining < minSplit * 2) {
      return null;
    }

    const half = Math.floor(maxRemaining / 2);
    const newStart = largest.current + half;
    const oldEnd = largest.end;

    largest.end = newStart - 1;

    this._nextSegId = Math.max(this._nextSegId || 0, this.segments.length) + 1;
    const newSeg = {
      id: this._nextSegId,
      start: newStart,
      current: newStart,
      committed: newStart,
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
    if (!headers.Referer && !headers.referer) {
      try { headers['Referer'] = `${parsed.protocol}//${parsed.host}/`; } catch (_) {}
    }
    if (!headers.Origin && !headers.origin) {
      try { headers['Origin'] = `${parsed.protocol}//${parsed.host}`; } catch (_) {}
    }
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
        rejectUnauthorized: !this.allowInsecureTls,
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
        const writeStart = Date.now();
        try {
          if (diskWriteError.err) return;
          if (this.fileHandle && (this.status === 'downloading' || this.status === 'paused')) {
            await this._writeVectorAtOffset(bufs, lenToWrite, offsetToWrite);
            const flushedEnd = offsetToWrite + lenToWrite;
            if (typeof seg.committed !== 'number' || flushedEnd > seg.committed) {
              seg.committed = flushedEnd;
            }
            const writeMs = Date.now() - writeStart;
            this._ewmaWriteMs = this._ewmaWriteMs ? (this._ewmaWriteMs * 0.8 + writeMs * 0.2) : writeMs;
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

    const noopErr = () => {};
    let detached = false;
    const detachListeners = () => {
      if (detached) return;
      detached = true;
      try {
        if (res) {
          res.removeListener('data', onChunk);
          res.removeListener('end', onEnd);
          res.removeListener('error', settleFailure);
          res.once('error', noopErr);
        }
        if (req) {
          req.removeListener('error', settleFailure);
          req.once('error', noopErr);
        }
      } catch {}
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
        detachListeners();
        try { if (res && !res.destroyed) res.destroy(); } catch {}
        try { if (req && !req.destroyed) req.destroy(); } catch {}
        return flushBuffer();
      }
    };
    this.activeWorkers.set(seg.id, workerEntry);

    const settleFailure = (err) => {
      if (workerSettled || finalized) return;
      workerSettled = true;
      detachListeners();
      if (this.activeWorkers.get(seg.id) !== workerEntry) return;
      flushBuffer().then(() => {
        if (this.activeWorkers.get(seg.id) === workerEntry) {
          this._handleWorkerFailure(seg, err);
        }
      });
    };

    const onChunk = (chunk) => {
      if (this.status !== 'downloading' || finalized || workerSettled) {
        detachListeners();
        if (res && !res.destroyed) res.destroy();
        return;
      }

      let usableLen = chunk.length;
      if (seg.end >= 0) {
        const remainingAllowed = seg.end - seg.current + 1;
        if (remainingAllowed <= 0) {
          finalized = true;
          detachListeners();
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
      if (usableLen > 0) {
        seg.retries = 0; // Forward progress clears transient failure streak
      }
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
        detachListeners();
        if (usableLen < chunk.length) {
          if (res && !res.destroyed) res.destroy();
        } else {
          try { if (res && !res.destroyed) res.resume(); } catch {}
        }
        this._completeSegment(seg, flushBuffer, workerEntry);
      }
    };

    const onEnd = () => {
      detachListeners();
      if (finalized || workerSettled || this.status !== 'downloading') return;
      if (seg.end < 0 || seg.current > seg.end) {
        finalized = true;
        this._completeSegment(seg, flushBuffer, workerEntry);
      } else {
        settleFailure(new Error('Stream ended prematurely'));
      }
    };

    if (initialChunk && initialChunk.length > 0) {
      onChunk(initialChunk);
      if (finalized) return workerEntry;
    }

    res.on('data', onChunk);
    res.on('end', onEnd);
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
      const sentRange = Boolean(reqOptions.headers['Range']);
      if (sentRange && code === 200) {
        const canFallbackSingle = seg.id === 0 && seg.current === 0 && this.downloadedBytes === 0 &&
          this.segments.every(s => s.current === s.start);
        if (canFallbackSingle) {
          this.acceptRanges = false;
          for (const s of this.segments) {
            if (s !== seg && this.activeWorkers.has(s.id)) {
              const other = this.activeWorkers.get(s.id);
              this.activeWorkers.delete(s.id);
              try { if (other && other.req) other.req.destroy(); } catch {}
            }
          }
          seg.start = 0;
          seg.current = 0;
          seg.committed = 0;
          seg.end = this.totalBytes > 0 ? (this.totalBytes - 1) : -1;
          this.segments = [seg];
          if (this.status === 'downloading' && seg.status === 'downloading') {
            workerEntry = this._consumeSegmentStream(seg, req, res);
          } else {
            try { res.destroy(); } catch {}
        try { req.destroy(); } catch {}
          }
          return;
        }
        try { res.destroy(); } catch {}
        try { req.destroy(); } catch {}
        const rangeErr = new Error('Server returned HTTP 200 instead of 206 Partial Content');
        rangeErr.fatalRangeError = true;
        failEarly(rangeErr);
        return;
      }
      if (code < 200 || code >= 300) {
        const retryAfterRaw = res.headers['retry-after'];
        try { res.destroy(); } catch {}
        try { req.destroy(); } catch {}
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
        try { res.destroy(); } catch {}
        try { req.destroy(); } catch {}
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
    req.setTimeout(30000, () => {
      if (this.status === 'downloading') {
        req.destroy(new Error('Socket read timeout'));
      }
    });

    req.end();
  }

  // Google "The Tail at Scale" Hedged Race: phóng request song song trên CDN IP khác nếu 1 kết nối kẹt
  _spawnHedgedRace(seg) {
    if (this.status !== 'downloading' || seg.status !== 'downloading' || !this.acceptRanges || seg._hedging) return;
    if (this._activeHedges >= 8) return;
    if (seg.end >= 0 && seg.current >= seg.end) return;

    seg._hedging = true;
    this._activeHedges++;
    const expectedStart = seg.current;
    const altIp = this._pickHealthyIp(seg, seg.ip);
    const { transport, reqOptions } = this._buildRequestOptions(seg, altIp || seg.ip, expectedStart);

    let claimed = false;
    let hedgeFinished = false;
    let streamPos = expectedStart;

    const releaseHedgeSlot = () => {
      if (!hedgeFinished) {
        hedgeFinished = true;
        this._activeHedges = Math.max(0, this._activeHedges - 1);
      }
    };

    const stopHedge = (res) => {
      seg._hedging = false;
      seg._abortHedge = null;
      releaseHedgeSlot();
      try { if (res && !res.destroyed) res.destroy(); } catch {}
      try { if (!req.destroyed) req.destroy(); } catch {}
    };
    seg._abortHedge = () => stopHedge(null);

    const req = transport.request(reqOptions, (res) => {
      const code = res.statusCode || 0;
      if ((reqOptions.headers['Range'] && code !== 206) ||
          code < 200 || code >= 300 || this.status !== 'downloading' || seg.status !== 'downloading') {
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
        seg._abortHedge = null;
        releaseHedgeSlot();
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
    req.on('error', () => {
      if (!claimed) {
        seg._hedging = false;
        releaseHedgeSlot();
      }
    });
    req.setTimeout(3500, () => { if (!claimed) stopHedge(null); });
    req.end();
  }

  _completeSegment(seg, flushBuffer, workerEntry) {
    if (seg._abortHedge) {
      seg._abortHedge();
      seg._abortHedge = null;
    }
    flushBuffer().then(() => {
      if (!workerEntry || this.activeWorkers.get(seg.id) === workerEntry) {
        this.activeWorkers.delete(seg.id);
      }
      if (this.status !== 'downloading') return;
      seg.status = 'completed';
      seg.speedBps = 0;
      this._compactCompletedSegments();
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
    if (seg._abortHedge) {
      seg._abortHedge();
      seg._abortHedge = null;
    }
    this.activeWorkers.delete(seg.id);
    if (this.status !== 'downloading') return;

    if (seg.end >= 0 && seg.current > seg.end) {
      seg.status = 'completed';
      seg.speedBps = 0;
      this._scheduleWorkers();
      return;
    }

    const isSelfRecycle = Boolean(err && err._selfRecycled);
    if (isSelfRecycle) {
      // Intentional watchdog recycle MUST NOT penalize retry count, halve connections, or stall the pool
      if (seg.ip && this.cdnIps.length > 1) {
        this._badIps.set(seg.ip, Date.now() + 4000);
      }
      seg.speedBps = 0;
      seg.status = 'pending';
      this._scheduleWorkers();
      return;
    }

    if (seg.ip && this.cdnIps.length > 1) {
      this._badIps.set(seg.ip, Date.now() + 15000);
    }

    seg.retries = (seg.retries || 0) + 1;
    seg.speedBps = 0;

    const code = err && err.statusCode;
    const msg = (err && err.message) || '';
    const isRateLimited = code === 429 || code === 503;

    if (isRateLimited) {
      this._completedSinceDecrease = 0;
      this._lastCongestionAt = Date.now();
      const targetCap = this._targetMaxConnections || this.maxConnections;
      this.effectiveMaxConnections = Math.max(8, Math.floor((this.effectiveMaxConnections || targetCap) / 2));
      const cooldown = (err && err.retryAfterMs) || Math.min(5000, 1000 * Math.min(seg.retries, 5));
      this._rateLimitUntil = Math.max(this._rateLimitUntil, Date.now() + cooldown);
    }

    // Track consecutive zero-progress failures; max 30/45 avoids killing large downloads on transient Wi-Fi/ISP hiccups
    const maxRetries = (err && err.fatalRangeError) ? Math.max(0, (this.cdnIps.length || 1) - 1) : (isRateLimited ? 45 : 30);
    if (seg.retries > maxRetries) {
      this.status = 'error';
      this.error = `Segment #${seg.id} failed after ${maxRetries} retries: ${msg}`;
      this._abortAllWorkers().then(() => this._cleanupHandles());
      this.emit('update', this.toJSON());
      return;
    }

    seg.status = 'pending';
    const expStep = Math.min(seg.retries, 14);
    const backoffMs = isRateLimited
      ? Math.min(12000, (err && err.retryAfterMs) || Math.round(800 * Math.pow(1.2, expStep)))
      : (seg.retries === 1 && this.cdnIps.length > 1
        ? 25 // Fast 25ms Multi-IP Edge Failover on first transient socket error
        : Math.min(1500, Math.round(150 * Math.pow(1.15, expStep))));
    const retryTimer = setTimeout(() => {
      this._retryTimers.delete(retryTimer);
      if (this.status === 'downloading') {
        this._scheduleWorkers();
      }
    }, backoffMs);
    retryTimer.unref?.();
    this._retryTimers.add(retryTimer);
  }

  _startTelemetryLoop() {
    this._stopTelemetryLoop();

    this._speedTimer = setInterval(() => {
      if (this.status !== 'downloading') return;
      const now = Date.now();
      const dt = Math.max(0.1, (now - this._lastTickTime) / 1000);
      const dBytes = Math.max(0, this.downloadedBytes - this._lastTickBytes);
      const instBps = Math.round(dBytes / dt);

      // 5.0s sliding byte-integral + light EWMA blend keeps speed & ETA calm and responsive
      this._speedWindow.push({ bytes: dBytes, dt });
      if (this._speedWindow.length > 10) this._speedWindow.shift();
      let winBytes = 0;
      let winDt = 0;
      for (const s of this._speedWindow) {
        winBytes += s.bytes;
        winDt += s.dt;
      }
      const winBps = winDt > 0 ? Math.round(winBytes / winDt) : instBps;
      this.currentSpeedBps = this._speedWindow.length >= 2
        ? Math.round(winBps * 0.85 + instBps * 0.15)
        : instBps;
      if (this.currentSpeedBps > this.peakSpeedBps) {
        this.peakSpeedBps = this.currentSpeedBps;
      }

      if (this.currentSpeedBps > 0) {
        this._etaSpeedEwma = this._etaSpeedEwma > 0
          ? Math.round(this._etaSpeedEwma * 0.78 + this.currentSpeedBps * 0.22)
          : this.currentSpeedBps;
      }
      if (this.totalBytes > 0 && this._etaSpeedEwma > 0) {
        const rem = Math.max(0, this.totalBytes - this.downloadedBytes);
        this.etaSeconds = Math.ceil(rem / this._etaSpeedEwma);
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
          const segInstBps = Math.round(seg.bytesInWindow / dt);
          seg.speedBps = seg.speedBps > 0 ? Math.round(seg.speedBps * 0.55 + segInstBps * 0.45) : segInstBps;
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

      // Time-based AIMD slow-start recovery: recover +2 connections every 5s of clean streaming
      const targetCap = this._targetMaxConnections || this.maxConnections;
      if (this.effectiveMaxConnections < targetCap && now >= (this._rateLimitUntil || 0)) {
        if (now - (this._lastCongestionAt || 0) >= 5000 && now - (this._lastAimdStepAt || 0) >= 5000) {
          this._lastAimdStepAt = now;
          this.effectiveMaxConnections = Math.min(targetCap, this.effectiveMaxConnections + 2);
        }
      }

      // Update EWMA per CDN Edge IP
      for (const [ip, bps] of ipAgg) {
        const prev = this._ipStats.get(ip);
        const ewma = prev ? Math.round(prev.ewmaBps * 0.7 + bps * 0.3) : bps;
        this._ipStats.set(ip, { ewmaBps: ewma, updatedAt: now });
      }

      // Adaptive Write-Coalescing Buffer Auto-Tuner (NVMe burst + slow HDD backpressure guard)
      if (this.currentSpeedBps > 100 * 1024 * 1024) {
        this._writeBufferSize = 2 * 1024 * 1024;
      } else if (this.currentSpeedBps > 10 * 1024 * 1024 || this._ewmaWriteMs > 35) {
        this._writeBufferSize = 1024 * 1024;
      } else {
        this._writeBufferSize = 512 * 1024;
      }

      // Periodically prune expired IP health/telemetry entries (zero unbounded Map growth)
      this._telemetryTick++;
      if (this._telemetryTick % 10 === 0) {
        for (const [ip, until] of this._badIps.entries()) {
          if (now >= until) this._badIps.delete(ip);
        }
        if (this._ipStats.size > 64) {
          for (const [ip, st] of this._ipStats.entries()) {
            if (now - st.updatedAt > 120000) this._ipStats.delete(ip);
          }
        }
      }

      const connLimit = this.effectiveMaxConnections || this.maxConnections;
      let medianSegSpeed = 0;
      if (activeSegs.length >= 3) {
        const sorted = activeSegs.map(s => s.speedBps).sort((a, b) => a - b);
        medianSegSpeed = sorted[sorted.length >> 1] || 0;
      }

      // Tail-Latency, Hedged Racing & Bounded Straggler Watchdog (max 2 recycles/tick)
      let recycledThisTick = 0;
      for (const seg of activeSegs) {
        const w = this.activeWorkers.get(seg.id);
        if (w && w.isDiskPaused && w.isDiskPaused()) {
          seg.lastDataTime = now;
          seg.slowTicks = 0;
          continue;
        }
        const idleMs = now - (seg.lastDataTime || now);
        const rem = seg.end - seg.current + 1;

        // 0) Google "The Tail at Scale" Hedged Request (bounded <=8 concurrent hedges in tail zone)
        const avgSegSpeed = (activeSegs.length >= 2 && this.currentSpeedBps > 512 * 1024)
          ? (this.currentSpeedBps / activeSegs.length)
          : 0;
        const inTailZone = this.totalBytes > 0 && (this.downloadedBytes / this.totalBytes) >= 0.92;
        const maxHedgesAllowed = inTailZone ? 8 : 4;
        const hedgeTrigger = (idleMs > 1500 && rem > 64 * 1024) ||
          (inTailZone && rem > 64 * 1024 && avgSegSpeed > 0 && seg.speedBps < Math.max(64 * 1024, avgSegSpeed * 0.35));

        if (this.acceptRanges && !seg._hedging && hedgeTrigger &&
            this._activeHedges < maxHedgesAllowed && (this.activeWorkers.size < connLimit || this.cdnIps.length > 1 || inTailZone)) {
          this._spawnHedgedRace(seg);
        }

        // 1) Recycle truly silent stalled socket (> 3.5s with 0 bytes) without poisoning retries
        if (idleMs > 3500 && rem > 0) {
          seg.lastDataTime = now;
          this.recycleCount++;
          if (w && w.req) {
            const recycleErr = new Error('Stalled socket recycled (>3.5s idle)');
            recycleErr._selfRecycled = true;
            w.req.destroy(recycleErr);
          }
          continue;
        }
        // 2) Only recycle genuinely crippled stragglers (<32 KB/s AND <5% avg for 3.0s, max 2/tick)
        if (recycledThisTick < 2 && activeSegs.length >= 3 && this.currentSpeedBps > 2 * 1024 * 1024) {
          const crippledFloor = Math.min(32 * 1024, Math.max(8 * 1024, avgSegSpeed * 0.05));
          const threshold = medianSegSpeed > 0
            ? Math.min(crippledFloor, medianSegSpeed * 0.08)
            : crippledFloor;
          if (rem > 1024 * 1024 && seg.speedBps < threshold) {
            seg.slowTicks = (seg.slowTicks || 0) + 1;
            if (seg.slowTicks >= 6) {
              seg.slowTicks = 0;
              recycledThisTick++;
              this.recycleCount++;
              if (w && w.req) {
                const stragglerErr = new Error('Straggler connection recycled to faster CDN edge');
                stragglerErr._selfRecycled = true;
                w.req.destroy(stragglerErr);
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
    if (this._retryTimers && this._retryTimers.size > 0) {
      for (const t of this._retryTimers) {
        clearTimeout(t);
      }
      this._retryTimers.clear();
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
    this._speedWindow = [];
    this._activeHedges = 0;
    this.etaSeconds = 0;

    await this._cleanupHandles();
    if (this._keepStateOnComplete) {
      if (this.stateFilePath) {
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
          segments: this.segments.map(s => ({
            id: s.id,
            start: s.start,
            current: s.end >= s.start ? s.end + 1 : s.current,
            end: s.end,
            status: 'completed'
          }))
        };
        await fsp.writeFile(this.stateFilePath, JSON.stringify(payload), 'utf8').catch(() => {});
      }
    } else if (this.stateFilePath && fs.existsSync(this.stateFilePath)) {
      await fsp.unlink(this.stateFilePath).catch(() => {});
    }
    if (this.filePath) {
      const key = this.filePath.toLowerCase();
      if (RESERVED_TARGET_PATHS.get(key) === this.id) RESERVED_TARGET_PATHS.delete(key);
    }

    this.emit('update', this.toJSON());
    this.emit('completed', this.toJSON());
  }

  async _abortAllWorkers() {
    this._stopTelemetryLoop();
    for (const seg of this.segments) {
      if (seg._abortHedge) {
        seg._abortHedge();
        seg._abortHedge = null;
      }
    }
    const flushes = [];
    for (const [, worker] of this.activeWorkers.entries()) {
      if (worker.abortSilently) {
        flushes.push(worker.abortSilently());
      } else {
        if (worker.flushBuffer) flushes.push(worker.flushBuffer());
        if (worker.req) worker.req.destroy();
        if (worker.getWriteChain) flushes.push(worker.getWriteChain());
      }
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
    if (this.filePath) {
      const key = this.filePath.toLowerCase();
      if (RESERVED_TARGET_PATHS.get(key) === this.id) RESERVED_TARGET_PATHS.delete(key);
    }
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
        segments: this.segments.map(s => {
          const safeCur = typeof s.committed === 'number'
            ? Math.max(s.start, Math.min(s.current, s.committed))
            : s.current;
          const clampedCur = s.end >= s.start ? Math.min(safeCur, s.end + 1) : safeCur;
          return {
            id: s.id,
            start: s.start,
            current: clampedCur,
            end: s.end,
            status: clampedCur > s.end && s.end >= 0 ? 'completed' : 'pending'
          };
        })
      };
      const jsonStr = this.segments.length > 128 ? JSON.stringify(payload) : JSON.stringify(payload, null, 2);
      const tmpPath = `${this.stateFilePath}.tmp`;
      try {
        await fsp.writeFile(tmpPath, jsonStr, 'utf8');
        await fsp.rename(tmpPath, this.stateFilePath);
      } catch {
        await fsp.writeFile(this.stateFilePath, jsonStr, 'utf8').catch(() => {});
      }
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
    const targetPath = fs.existsSync(this.stateFilePath)
      ? this.stateFilePath
      : (fs.existsSync(`${this.stateFilePath}.tmp`) ? `${this.stateFilePath}.tmp` : '');
    if (!targetPath || !fs.existsSync(this.filePath)) {
      return false;
    }
    try {
      const raw = await fsp.readFile(targetPath, 'utf8');
      const data = JSON.parse(raw);
      if (data.totalBytes !== this.totalBytes || !Array.isArray(data.segments)) return false;
      if (this.etag && data.etag && data.etag !== this.etag) return false;
      if (this.lastModified && data.lastModified && data.lastModified !== this.lastModified) return false;

      this.segments = data.segments.map(s => {
        const resumeCur = typeof s.committed === 'number'
          ? Math.max(s.start, Math.min(s.current, s.committed))
          : s.current;
        return {
          id: s.id,
          start: s.start,
          current: resumeCur,
          committed: resumeCur,
          end: s.end,
          status: resumeCur > s.end && s.end >= 0 ? 'completed' : 'pending',
          speedBps: 0,
          ip: '',
          retries: 0,
          bytesInWindow: 0
        };
      });
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
      if (base && base !== '/' && base !== '.' && !isGenericFileName(base)) {
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
    const reserve = (chosenPath) => {
      RESERVED_TARGET_PATHS.set(chosenPath.toLowerCase(), this.id);
      return chosenPath;
    };
    const isTakenByOther = (candidatePath) => {
      const owner = RESERVED_TARGET_PATHS.get(candidatePath.toLowerCase());
      if (owner && owner !== this.id) return true;
      return fs.existsSync(candidatePath) || fs.existsSync(`${candidatePath}.hyper.json`);
    };

    const journalPath = `${initialPath}.hyper.json`;
    if (fs.existsSync(journalPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
        const existingOwner = RESERVED_TARGET_PATHS.get(initialPath.toLowerCase());
        if (meta && (meta.id === this.id || (!existingOwner && meta.url === this.url))) {
          return reserve(initialPath);
        }
      } catch {}
    } else if (this.filePath === initialPath && this.downloadedBytes > 0 && fs.existsSync(initialPath)) {
      return reserve(initialPath);
    }
    if (!isTakenByOther(initialPath)) return reserve(initialPath);

    const dir = path.dirname(initialPath);
    const ext = path.extname(initialPath);
    const base = path.basename(initialPath, ext);
    for (let i = 1; i < 1000; i++) {
      const candidate = path.join(dir, `${base} (${i})${ext}`);
      if (!isTakenByOther(candidate)) return reserve(candidate);
    }
    return reserve(path.join(dir, `${base}_${Date.now()}${ext}`));
  }

  static async probeYoutubeInfo(url, timeoutMs = 8000) {
    const cleanUrl = String(url || '').trim();
    const cached = YT_PROBE_CACHE.get(cleanUrl);
    if (cached && (Date.now() - cached.ts) < 10 * 60 * 1000) {
      return cached.data;
    }

    const ytdlp = findBinary('yt-dlp.exe');
    const info = await new Promise((resolve, reject) => {
      execFile(ytdlp, ['--no-warnings', '--no-playlist', '--dump-single-json', cleanUrl], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: timeoutMs
      }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      });
    });

    const formats = Array.isArray(info.formats) ? info.formats : [];
    const httpsAudio = formats.filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none' && /^https?$/i.test(f.protocol || ''));
    const m4aAudio = httpsAudio.filter(f => f.ext === 'm4a').sort((a, b) => (b.abr || 0) - (a.abr || 0));
    const bestAudio = m4aAudio[0] || httpsAudio.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0] || null;
    const audioBytes = Number((bestAudio && (bestAudio.filesize || bestAudio.filesize_approx)) || 0);

    let videoPool = formats.filter(f => f.vcodec && f.vcodec !== 'none' && (f.height || f.width) && /^https?$/i.test(f.protocol || ''));
    if (videoPool.length === 0) {
      videoPool = formats.filter(f => f.vcodec && f.vcodec !== 'none' && (f.height || f.width));
    }

    const getEffH = (f) => Math.max(Number(f.height || 0), Math.round(Number(f.width || 0) * 9 / 16));
    const pickBest = (list) => {
      if (!list.length) return null;
      return list.slice().sort((a, b) => {
        const dh = getEffH(b) - getEffH(a);
        if (dh !== 0) return dh;
        const df = Number(b.fps || 0) - Number(a.fps || 0);
        if (df !== 0) return df;
        return Number(b.tbr || 0) - Number(a.tbr || 0);
      })[0];
    };

    const topVideo = pickBest(videoPool);
    const qualities = [{
      key: 'best',
      label: topVideo ? `Tối đa tự động (${topVideo.height || getEffH(topVideo)}p${topVideo.fps >= 50 ? Math.round(topVideo.fps) : ''})` : 'Tối đa tự động (Cao nhất)',
      available: Boolean(topVideo),
      bytes: topVideo ? Number(topVideo.filesize || topVideo.filesize_approx || 0) + audioBytes : 0,
      height: topVideo ? getEffH(topVideo) : 0
    }];

    for (const tier of YT_QUALITY_TIERS) {
      const matched = pickBest(videoPool.filter(f => {
        const eh = getEffH(f);
        return eh >= tier.minH && eh <= tier.maxH;
      }));
      qualities.push({
        key: tier.key,
        label: tier.label,
        available: Boolean(matched),
        bytes: matched ? Number(matched.filesize || matched.filesize_approx || 0) + audioBytes : 0,
        height: matched ? getEffH(matched) : 0,
        fps: matched ? Number(matched.fps || 0) : 0
      });
    }

    qualities.push({
      key: 'audio',
      label: 'Chỉ Âm thanh (M4A)',
      available: Boolean(bestAudio),
      bytes: audioBytes,
      height: 0
    });

    const sanitizedTitle = String(info.title || '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();
    const data = {
      title: sanitizedTitle,
      fileName: sanitizedTitle ? `${sanitizedTitle}.mp4` : '',
      totalBytes: qualities[0].bytes || 0,
      maxHeight: topVideo ? getEffH(topVideo) : 0,
      qualities
    };

    if (YT_PROBE_CACHE.size >= 50) {
      const oldestKey = YT_PROBE_CACHE.keys().next().value;
      if (oldestKey) YT_PROBE_CACHE.delete(oldestKey);
    }
    YT_PROBE_CACHE.set(cleanUrl, { ts: Date.now(), data });
    return data;
  }
}

function netIsIp(host) {
  return net.isIP(host) !== 0;
}

module.exports = {
  DownloadJob,
  isGenericFileName,
  extractGoogleDriveFileId,
  decodeRfc2047,
  parseGoogleDriveFolder,
  CloudResolver
};
