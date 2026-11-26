// [VERIFIED-GOLDEN: part5-core-automated-test-lab | 2026-11-26 | DO NOT MODIFY UNLESS TARGETED]
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const { DownloadJob, CloudResolver } = require('../engine');
const idmFeatures = require('../idm-features');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      s.close(() => resolve(addr.port));
    });
  });
}

function makePayload(sizeBytes) {
  const buf = Buffer.allocUnsafe(sizeBytes);
  for (let i = 0; i < sizeBytes; i += 4) {
    buf.writeUInt32LE((i * 2654435761) >>> 0, i);
  }
  return buf;
}

function startRangeServer(payload, { getMode = () => 'range' } = {}) {
  const etag = '"duytai-test-v1"';
  const requestedRanges = [];
  const srv = http.createServer((req, res) => {
    const mode = getMode(req);
    const range = req.headers['range'];

    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': payload.length,
        'Accept-Ranges': mode === 'ignore-range' ? 'none' : 'bytes',
        'ETag': etag,
        'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        'Content-Type': 'application/octet-stream'
      });
      return res.end();
    }

    if (range) requestedRanges.push(range);

    if (mode === 'ignore-range' || (mode === 'reject-nonzero-range' && range && !range.startsWith('bytes=0-'))) {
      res.writeHead(200, {
        'Content-Length': payload.length,
        'ETag': etag,
        'Content-Type': 'application/octet-stream'
      });
      return res.end(payload);
    }

    if (range && range.startsWith('bytes=')) {
      const [sStr, eStr] = range.slice(6).split('-');
      const start = parseInt(sStr, 10) || 0;
      const end = eStr ? Math.min(payload.length - 1, parseInt(eStr, 10)) : payload.length - 1;
      if (start >= payload.length || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${payload.length}` });
        return res.end();
      }
      const slice = payload.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Accept-Ranges': 'bytes',
        'ETag': etag,
        'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
        'Content-Type': 'application/octet-stream'
      });
      return res.end(slice);
    }

    res.writeHead(200, {
      'Content-Length': payload.length,
      'Accept-Ranges': mode === 'ignore-range' ? 'none' : 'bytes',
      'ETag': etag,
      'Content-Type': 'application/octet-stream'
    });
    return res.end(payload);
  });

  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({
        url: `http://127.0.0.1:${port}/payload.bin`,
        requestedRanges,
        close: () => new Promise((r) => srv.close(r))
      });
    });
  });
}

function waitForJobTerminal(job, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (job.status === 'completed' || job.status === 'error' || job.status === 'canceled') {
      return resolve(job.status);
    }
    const t = setTimeout(() => reject(new Error(`Timeout waiting for job (${job.status}: ${job.error || ''})`)), timeoutMs);
    const onUpdate = () => {
      if (job.status === 'completed' || job.status === 'error' || job.status === 'canceled') {
        clearTimeout(t);
        job.off('update', onUpdate);
        resolve(job.status);
      }
    };
    job.on('update', onUpdate);
  });
}

test('DownloadJob completes 206 multi-segment download with exact SHA-256 and removes journal', async () => {
  const dir = makeTempDir('duytai-t1-');
  const payload = makePayload(2 * 1024 * 1024);
  const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
  const srv = await startRangeServer(payload);

  try {
    const job = new DownloadJob({
      url: srv.url,
      saveDir: dir,
      fileName: 'multi.bin',
      maxConnections: 4
    });
    idmFeatures.attachIdmFeatures(job, {
      baseDir: dir,
      autoCategory: false,
      verify: true,
      expectedHash: expectedSha
    });

    const terminal = waitForJobTerminal(job);
    job.start();
    const st = await terminal;

    assert.equal(st, 'completed');
    assert.equal(job.status, 'completed');
    assert.equal(job.toJSON().progress, 100);
    assert.ok(srv.requestedRanges.length >= 2, 'Expected ranged requests');

    const actualBuf = await fsp.readFile(path.join(dir, 'multi.bin'));
    const actualSha = crypto.createHash('sha256').update(actualBuf).digest('hex');
    assert.equal(actualSha, expectedSha);
    assert.equal(fs.existsSync(path.join(dir, 'multi.bin.hyper.json')), false);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('DownloadJob cleanly handles HTTP 200 on Range-ignoring server without corruption', async () => {
  const dir = makeTempDir('duytai-t2-');
  const payload = makePayload(512 * 1024);
  const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
  const srv = await startRangeServer(payload, { getMode: () => 'ignore-range' });

  try {
    const job = new DownloadJob({
      url: srv.url,
      saveDir: dir,
      fileName: 'norange.bin',
      maxConnections: 4
    });

    const terminal = waitForJobTerminal(job);
    job.start();
    const st = await terminal;

    assert.equal(st, 'completed');
    assert.equal(job.acceptRanges, false);
    const actualSha = crypto.createHash('sha256').update(await fsp.readFile(path.join(dir, 'norange.bin'))).digest('hex');
    assert.equal(actualSha, expectedSha);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('DownloadJob rejects mid-segment HTTP 200 and resumes strictly from committed cursor on HTTP 206', async () => {
  const dir = makeTempDir('duytai-t3-');
  const payload = makePayload(1024 * 1024);
  const expectedSha = crypto.createHash('sha256').update(payload).digest('hex');
  const half = 512 * 1024;
  let serverMode = 'reject-nonzero-range';
  const srv = await startRangeServer(payload, { getMode: () => serverMode });

  try {
    const targetFile = path.join(dir, 'resume.bin');
    const journalFile = path.join(dir, 'resume.bin.hyper.json');

    // Simulate crash where 128KB of seg0 was committed to disk while buffered `current` was ahead (256KB)
    const diskBuf = Buffer.alloc(payload.length, 0);
    payload.copy(diskBuf, 0, 0, 128 * 1024);
    await fsp.writeFile(targetFile, diskBuf);
    await fsp.writeFile(journalFile, JSON.stringify({
      id: 'res-job-1',
      version: 2,
      url: srv.url,
      finalUrl: srv.url,
      totalBytes: payload.length,
      acceptRanges: true,
      etag: '"duytai-test-v1"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
      fileName: 'resume.bin',
      filePath: targetFile,
      segments: [
        { id: 0, start: 0, current: 256 * 1024, committed: 128 * 1024, end: half - 1, status: 'paused' },
        { id: 1, start: half, current: half, committed: half, end: payload.length - 1, status: 'paused' }
      ]
    }));

    // 1) Server returns HTTP 200 on non-zero resume -> MUST abort instead of overwriting offset 0
    const badJob = new DownloadJob({
      id: 'res-job-1',
      url: srv.url,
      saveDir: dir,
      fileName: 'resume.bin',
      maxConnections: 2
    });
    const badTerm = waitForJobTerminal(badJob);
    badJob.start();
    const badSt = await badTerm;
    assert.equal(badSt, 'error');
    assert.match(badJob.error || '', /HTTP 200|Range|206/i);

    // 2) Flip server back to proper 206 -> MUST resume segment 0 from committed (131072), NOT buffered 262144
    serverMode = 'range';
    srv.requestedRanges.length = 0;

    const okJob = new DownloadJob({
      id: 'res-job-1',
      url: srv.url,
      saveDir: dir,
      fileName: 'resume.bin',
      maxConnections: 2
    });
    const okTerm = waitForJobTerminal(okJob);
    okJob.start();
    const okSt = await okTerm;

    assert.equal(okSt, 'completed');
    assert.ok(srv.requestedRanges.some(r => r.startsWith('bytes=131072-')), `Expected Range starting at 131072, got: ${srv.requestedRanges.join(', ')}`);
    const actualSha = crypto.createHash('sha256').update(await fsp.readFile(targetFile)).digest('hex');
    assert.equal(actualSha, expectedSha);
  } finally {
    await srv.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('idm-features blocks SSRF URLs, expands batch patterns, categorizes files, and SpeedLimiter respects disk pause', async () => {
  for (const blocked of [
    'http://127.0.0.1:17890/api/jobs',
    'http://localhost/test',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal.zip',
    'http://[::1]/secret',
    'file:///C:/Windows/win.ini'
  ]) {
    await assert.rejects(() => idmFeatures.assertSafeRemoteUrl(blocked));
  }

  const safe = await idmFeatures.assertSafeRemoteUrl('https://93.184.216.34/archive.zip');
  assert.equal(safe.hostname, '93.184.216.34');

  assert.deepEqual(
    idmFeatures.expandBatchPattern('https://cdn.example.com/part[01-03].zip'),
    [
      'https://cdn.example.com/part01.zip',
      'https://cdn.example.com/part02.zip',
      'https://cdn.example.com/part03.zip'
    ]
  );

  assert.equal(idmFeatures.categorize({ fileName: 'iPhone_Restore.ipsw' }), 'Firmware_ISO');
  assert.equal(idmFeatures.categorize({ fileName: 'bundle.7z' }), 'Compressed');

  let normalResumed = 0;
  let diskPausedResumed = 0;
  const res1 = { destroyed: false, isPaused: () => true, pause: () => {}, resume: () => { normalResumed++; } };
  const res2 = { destroyed: false, isPaused: () => true, pause: () => {}, resume: () => { diskPausedResumed++; } };
  const w1 = { req: { res: res1 }, isDiskPaused: () => false };
  const w2 = { req: { res: res2 }, isDiskPaused: () => true };
  const fakeJob = {
    id: 'j1',
    status: 'downloading',
    downloadedBytes: 0,
    segments: [{ id: 1 }, { id: 2 }],
    activeWorkers: new Map([[1, w1], [2, w2]])
  };
  const limiter = new idmFeatures.SpeedLimiter(() => [fakeJob]);
  limiter._paused.set(res1, w1);
  limiter._paused.set(res2, w2);
  limiter._tick();
  assert.equal(normalResumed, 1);
  assert.equal(diskPausedResumed, 0);

  // Verify cancel() supports both list-only removal (deleteFile=false) and Recycle Bin handler (deleteFile=true)
  const cancelDir = makeTempDir('duytai-cancel-');
  try {
    const dummyJob = new DownloadJob({
      id: 'cancel-test-1',
      url: 'https://93.184.216.34/video.mp4',
      saveDir: cancelDir,
      fileName: 'video.mp4',
      maxConnections: 2
    });
    const baseFile = path.join(cancelDir, 'video.mp4');
    dummyJob.filePath = baseFile;
    fs.writeFileSync(baseFile, 'main', 'utf8');
    fs.writeFileSync(`${baseFile}.video.tmp`, 'vtrack', 'utf8');
    fs.writeFileSync(`${baseFile}.audio.tmp`, 'atrack', 'utf8');
    fs.writeFileSync(`${baseFile}.video.tmp.hyper.json`, '{}', 'utf8');

    const trashed = [];
    await dummyJob.cancel(true, {
      moveToTrashFn: async (files) => {
        for (const f of files) {
          trashed.push(path.basename(f));
          await fsp.unlink(f);
        }
      }
    });
    assert.deepEqual(trashed.sort(), ['video.mp4', 'video.mp4.audio.tmp', 'video.mp4.video.tmp']);
    assert.equal(fs.existsSync(`${baseFile}.video.tmp.hyper.json`), false);
  } finally {
    fs.rmSync(cancelDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('server.js enforces token auth, Host/Origin checks, safe zip-preview, single token on EADDRINUSE, and clean shutdown', async () => {
  const dataDir = makeTempDir('duytai-srv-');
  const histFile = path.join(dataDir, 'jobs-history.json');
  const tokenFile = path.join(dataDir, 'auth.token');
  fs.writeFileSync(histFile, '[]', 'utf8');
  const port = await getFreePort();
  const baseEnv = {
    ...process.env,
    HYPER_IDM_PORT: String(port),
    DUYTAI_DATA_DIR: dataDir,
    HYPER_IDM_HISTORY_FILE: histFile,
    DUYTAI_TOKEN_FILE: tokenFile
  };

  const serverPath = path.join(__dirname, '..', 'server.js');
  const proc = spawn(process.execPath, [serverPath], {
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    // Wait until auth.token exists and server accepts connections
    let token = '';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (fs.existsSync(tokenFile)) {
        const candidate = fs.readFileSync(tokenFile, 'utf8').trim();
        if (candidate) {
          token = candidate;
          try {
            const ping = await fetch(`http://127.0.0.1:${port}/api/jobs`);
            if (ping.status === 401) break;
          } catch {}
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(token.length >= 32, 'Expected generated auth.token');

    // 1) Missing token -> 401
    const unauthRes = await fetch(`http://127.0.0.1:${port}/api/jobs`);
    assert.equal(unauthRes.status, 401);

    // 2) Untrusted Origin -> 403
    const evilOriginRes = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      headers: { Origin: 'https://evil.example', 'X-Duytai-Token': token }
    });
    assert.equal(evilOriginRes.status, 403);

    // 3) Valid token -> 200
    const authRes = await fetch(`http://127.0.0.1:${port}/api/jobs`, {
      headers: { 'X-Duytai-Token': token }
    });
    assert.equal(authRes.status, 200);
    const authBody = await authRes.json();
    assert.ok(Array.isArray(authBody.jobs));

    // 4) Index HTML injects meta duytai-token
    const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(htmlRes.status, 200);
    const htmlText = await htmlRes.text();
    assert.ok(htmlText.includes(`<meta name="duytai-token" content="${token}"`));

    // 5) Arbitrary local filePath in /api/zip-preview blocked
    const zipBad = await fetch(`http://127.0.0.1:${port}/api/zip-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Duytai-Token': token },
      body: JSON.stringify({ filePath: path.join(dataDir, 'secret.zip') })
    });
    assert.equal(zipBad.status, 400);

    // 6) Spawning second server on same port exits non-zero without overwriting auth.token
    const dupProc = spawn(process.execPath, [serverPath], {
      env: baseEnv,
      stdio: 'ignore'
    });
    const dupExit = await new Promise((resolve) => dupProc.once('exit', code => resolve(code)));
    assert.notEqual(dupExit, 0);
    assert.equal(fs.readFileSync(tokenFile, 'utf8').trim(), token);

    // 7) Graceful /api/shutdown exits process cleanly and cleans token file
    const shutRes = await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      headers: { 'X-Duytai-Token': token }
    });
    assert.equal(shutRes.status, 200);
    const mainExit = await new Promise((resolve) => proc.once('exit', code => resolve(code)));
    assert.equal(mainExit, 0);
    assert.equal(fs.existsSync(tokenFile), false);
  } finally {
    if (proc.exitCode === null) proc.kill();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('CloudResolver resolves Google Drive, Docs, Dropbox, GitHub, GitLab, Hugging Face, OneDrive, and Archive.org', async () => {
  const g1 = CloudResolver.resolveSync('https://drive.google.com/file/d/18xuxRBUnxstFx_PaCOlJadHIUMR51a8G/view');
  assert.equal(g1.type, 'gdrive');
  assert.ok(g1.url.includes('drive.usercontent.google.com'));

  const gdoc = CloudResolver.resolveSync('https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit');
  assert.equal(gdoc.type, 'gdoc');
  assert.ok(gdoc.url.includes('export?format=docx'));

  const drop = CloudResolver.resolveSync('https://www.dropbox.com/scl/fi/abc123xyz/sample.zip?rlkey=key123&dl=0');
  assert.equal(drop.type, 'dropbox');
  assert.ok(drop.url.includes('dl=1'));

  const gh = CloudResolver.resolveSync('https://github.com/torvalds/linux/blob/master/Makefile');
  assert.equal(gh.type, 'github-raw');
  assert.equal(gh.url, 'https://raw.githubusercontent.com/torvalds/linux/master/Makefile');

  const gl = CloudResolver.resolveSync('https://gitlab.com/gitlab-org/gitlab/-/blob/master/README.md');
  assert.equal(gl.type, 'gitlab-raw');
  assert.equal(gl.url, 'https://gitlab.com/gitlab-org/gitlab/-/raw/master/README.md');

  const hf = CloudResolver.resolveSync('https://huggingface.co/bert-base-uncased/blob/main/config.json');
  assert.equal(hf.type, 'huggingface');
  assert.ok(hf.url.includes('/resolve/main/config.json?download=true'));

  const one = CloudResolver.resolveSync('https://onedrive.live.com/?cid=1234567890ABCDEF&resid=1234567890ABCDEF%21105&authkey=Key123');
  assert.equal(one.type, 'onedrive');
  assert.ok(one.url.includes('/download?cid='));

  const arc = CloudResolver.resolveSync('https://archive.org/details/msdos_Oregon_Trail_The_1990/Oregon_Trail_1990.zip');
  assert.equal(arc.type, 'archiveorg');
  assert.equal(arc.url, 'https://archive.org/download/msdos_Oregon_Trail_The_1990/Oregon_Trail_1990.zip');

  const pd = CloudResolver.resolveSync('https://pixeldrain.com/u/AbCdEf123');
  assert.equal(pd.type, 'pixeldrain');
  assert.equal(pd.url, 'https://pixeldrain.com/api/file/AbCdEf123?download');

  const bb = CloudResolver.resolveSync('https://bitbucket.org/owner/repo/src/main/firmware.bin');
  assert.equal(bb.type, 'bitbucket-raw');
  assert.equal(bb.url, 'https://bitbucket.org/owner/repo/raw/main/firmware.bin');

  const sf = CloudResolver.resolveSync('https://sourceforge.net/projects/sevenzip/files/7-Zip/24.08/7z2408-x64.exe/download');
  assert.equal(sf.type, 'sourceforge');
  assert.ok(sf.url.includes('downloads.sourceforge.net/project/sevenzip/7-Zip/24.08/7z2408-x64.exe'));

  const sp = CloudResolver.resolveSync('https://contoso.sharepoint.com/:u:/s/eng/Eabc123');
  assert.equal(sp.type, 'sharepoint');
  assert.ok(sp.url.includes('download=1'));
});

test('DownloadJob Native HLS (.m3u8) 64-Thread Engine downloads master/media playlist and reorders segments sequentially', async () => {
  const dir = makeTempDir('duytai-hls-');
  const seg0 = Buffer.from('SEGMENT_ZERO_PAYLOAD_');
  const seg1 = Buffer.from('SEGMENT_ONE_PAYLOAD_');
  const seg2 = Buffer.from('SEGMENT_TWO_PAYLOAD');
  const expected = Buffer.concat([seg0, seg1, seg2]);

  const srv = http.createServer((req, res) => {
    if (req.url === '/master.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4500000\nhigh.m3u8\n');
    }
    if (req.url === '/high.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\nseg0.ts\nseg1.ts\nseg2.ts\n#EXT-X-ENDLIST\n');
    }
    if (req.url === '/seg0.ts') return res.end(seg0);
    if (req.url === '/seg1.ts') return res.end(seg1);
    if (req.url === '/seg2.ts') return res.end(seg2);
    res.writeHead(404);
    res.end();
  });

  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  try {
    const job = new DownloadJob({
      url: `http://127.0.0.1:${port}/master.m3u8`,
      saveDir: dir,
      fileName: 'stream.ts',
      maxConnections: 16
    });
    const terminal = waitForJobTerminal(job);
    job.start();
    const st = await terminal;
    assert.equal(st, 'completed');
    const actual = await fsp.readFile(path.join(dir, 'stream.ts'));
    assert.deepEqual(actual, expected);
  } finally {
    await new Promise(r => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('DownloadJob HLS RFC 8216 AES-128 + EXT-X-MAP fMP4 preserves plaintext init.mp4, Media-Sequence IV, out-of-order flush, and cleans .hls.tmp on failure', async () => {
  const dir = makeTempDir('duytai-hls-aes-');
  const aesKey = crypto.randomBytes(16);
  const initMp4 = Buffer.from('FTYP_MOOV_PLAIN_FMP4_HEADER_DO_NOT_DECRYPT');
  const baseSeq = 108;
  const plainSegs = Array.from({ length: 12 }, (_, i) =>
    Buffer.from(`FMP4_MOOF_MDAT_SEGMENT_${String(i).padStart(2, '0')}_` + 'X'.repeat(200 + i * 17))
  );
  const encSegs = plainSegs.map((plain, i) => {
    const iv = Buffer.alloc(16, 0);
    iv.writeBigUInt64BE(BigInt(baseSeq + i), 8);
    const cipher = crypto.createCipheriv('aes-128-cbc', aesKey, iv);
    return Buffer.concat([cipher.update(plain), cipher.final()]);
  });
  const expected = Buffer.concat([initMp4, ...plainSegs]);

  const srv = http.createServer((req, res) => {
    if (req.url === '/fmp4.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      const body = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        `#EXT-X-MEDIA-SEQUENCE:${baseSeq}`,
        '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"',
        '#EXT-X-MAP:URI="init.mp4"',
        ...encSegs.map((_, i) => `#EXTINF:2.0,\nseg_${i}.m4s`),
        '#EXT-X-ENDLIST'
      ].join('\n');
      return res.end(body);
    }
    if (req.url === '/broken.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXTINF:2.0,\nok.ts\n#EXTINF:2.0,\nmissing.ts\n#EXT-X-ENDLIST\n');
    }
    if (req.url === '/ok.ts') return res.end(Buffer.from('PARTIAL_OK'));
    if (req.url === '/enc.key') return res.end(aesKey);
    if (req.url === '/init.mp4') return res.end(initMp4);
    const m = /^\/seg_(\d+)\.m4s$/.exec(req.url || '');
    if (m) {
      const idx = Number(m[1]);
      // Deliberately reverse response latency so later segments arrive before earlier ones
      const delayMs = (12 - idx) * 6;
      return setTimeout(() => res.end(encSegs[idx]), delayMs);
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  try {
    const job = new DownloadJob({
      url: `http://127.0.0.1:${port}/fmp4.m3u8`,
      saveDir: dir,
      fileName: 'movie.m4s',
      maxConnections: 16
    });
    const terminal = waitForJobTerminal(job);
    job.start();
    const st = await terminal;
    assert.equal(st, 'completed');
    const actual = await fsp.readFile(path.join(dir, 'movie.m4s'));
    assert.equal(
      crypto.createHash('sha256').update(actual).digest('hex'),
      crypto.createHash('sha256').update(expected).digest('hex')
    );

    // Failing HLS stream must clean up .hls.tmp and not leak partial temp file
    const badJob = new DownloadJob({
      url: `http://127.0.0.1:${port}/broken.m3u8`,
      saveDir: dir,
      fileName: 'broken.ts',
      maxConnections: 4
    });
    const badTerm = waitForJobTerminal(badJob);
    badJob.start();
    const badSt = await badTerm;
    assert.equal(badSt, 'error');
    assert.equal(fs.existsSync(path.join(dir, 'broken.ts.hls.tmp')), false);
  } finally {
    await new Promise(r => srv.close(r));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
// [/VERIFIED-GOLDEN]
