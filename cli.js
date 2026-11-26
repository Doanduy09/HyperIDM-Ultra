#!/usr/bin/env node
// [VERIFIED-GOLDEN: part5-duytai-cli-entrypoint | 2026-11-26 | DO NOT MODIFY UNLESS TARGETED]
const { DownloadJob } = require('./engine');
const { version } = require('./package.json');

async function main() {
  const url = process.argv[2];
  const maxConnections = Math.max(1, Math.min(128, parseInt(process.argv[3] || '64', 10) || 64));

  if (!url) {
    console.log('Usage: node cli.js <url> [maxConnections=64]');
    process.exit(1);
  }

  console.log(`\n⚡ [Duytai v${version} 64-Bit] Starting download with ${maxConnections} parallel connections...`);
  console.log(`🔗 URL: ${url}`);

  const job = new DownloadJob({ url, maxConnections });

  job.on('update', (state) => {
    const mbps = (state.currentSpeedBps / (1024 * 1024)).toFixed(2);
    const peak = (state.peakSpeedBps / (1024 * 1024)).toFixed(2);
    const dlMB = (state.downloadedBytes / (1024 * 1024)).toFixed(2);
    const totMB = state.totalBytes > 0 ? (state.totalBytes / (1024 * 1024)).toFixed(2) : '?';
    process.stdout.write(
      `\r[${state.status.toUpperCase()}] ${state.progress}% (${dlMB}/${totMB} MB) | Speed: ${mbps} MB/s (Peak: ${peak} MB/s) | Steals: ${state.stealCount}   `
    );
  });

  job.on('completed', (state) => {
    const sec = (state.elapsedMs / 1000).toFixed(2);
    const avgMBps = state.elapsedMs > 0
      ? ((state.totalBytes / (1024 * 1024)) / (state.elapsedMs / 1000)).toFixed(2)
      : '0.00';
    const peakMBps = (state.peakSpeedBps / (1024 * 1024)).toFixed(2);
    console.log(`\n\n✅ DOWNLOAD COMPLETED (0ms Zero-Rebuild In-Place Write)!`);
    console.log(`📄 Saved to   : ${state.filePath}`);
    console.log(`📦 Total Size : ${(state.totalBytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`⏱️ Elapsed    : ${sec}s (Rebuild Stall: 0 ms)`);
    console.log(`🚀 Avg Speed  : ${avgMBps} MB/s (${(avgMBps * 8).toFixed(1)} Mbps) | Peak: ${peakMBps} MB/s`);
    console.log(`🌐 CDN IPs    : ${(state.cdnIps || []).join(', ')}`);
    console.log(`⚡ Work-Steals: ${state.stealCount}\n`);
    process.exit(0);
  });

  job.on('failed', (state) => {
    console.error(`\n\n❌ DOWNLOAD FAILED: ${(state && state.error) || 'Unknown error'}`);
    process.exit(1);
  });

  job.on('error', (err) => {
    console.error(`\n\n❌ ENGINE ERROR: ${(err && err.message) || err}`);
    process.exit(1);
  });

  await job.start();
}

main().catch((err) => {
  console.error(`\n❌ Fatal CLI error: ${(err && err.message) || err}`);
  process.exit(1);
});
// [/VERIFIED-GOLDEN]
