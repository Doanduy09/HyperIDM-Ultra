#!/usr/bin/env node
// [VERIFIED-GOLDEN: single-source-version-sync | 2026-11-26 | DO NOT MODIFY UNLESS TARGETED]
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!match) {
  console.error(`Invalid semver in package.json: ${version}`);
  process.exit(1);
}

const major = Number(match[1]);
const minor = Number(match[2]);
const patch = Number(match[3]);
const version4 = `${version}.0`;
const versionCode = String(major * 100 + minor * 10 + patch);
const checkOnly = process.argv.includes('--check');

const targets = [
  {
    rel: 'HyperIDM.cs',
    apply: (s) => s
      .replace(/\[assembly:\s*AssemblyVersion\("[^"]+"\)\]/, `[assembly: AssemblyVersion("${version4}")]`)
      .replace(/\[assembly:\s*AssemblyFileVersion\("[^"]+"\)\]/, `[assembly: AssemblyFileVersion("${version4}")]`)
      .replace(/\[assembly:\s*AssemblyInformationalVersion\("[^"]+"\)\]/, `[assembly: AssemblyInformationalVersion("${version}")]`),
  },
  {
    rel: 'SetupBootstrap.cs',
    apply: (s) => s
      .replace(/\[assembly:\s*AssemblyVersion\("[^"]+"\)\]/, `[assembly: AssemblyVersion("${version4}")]`)
      .replace(/\[assembly:\s*AssemblyFileVersion\("[^"]+"\)\]/, `[assembly: AssemblyFileVersion("${version4}")]`)
      .replace(/\[assembly:\s*AssemblyInformationalVersion\("[^"]+"\)\]/, `[assembly: AssemblyInformationalVersion("${version}")]`),
  },
  {
    rel: 'Install-HyperIDM.ps1',
    apply: (s) => s.replace(
      /(-Name\s+"DisplayVersion"\s+-Value\s+")[^"]+(")/,
      `$1${version}$2`
    ),
  },
  {
    rel: 'macos/build-macos-app.sh',
    apply: (s) => s
      .replace(/(<key>CFBundleShortVersionString<\/key><string>)[^<]+(<\/string>)/, `$1${version}$2`)
      .replace(/(<key>CFBundleVersion<\/key><string>)[^<]+(<\/string>)/, `$1${versionCode}$2`),
  },
  {
    rel: 'macos/Install-Duytai-macOS.sh',
    apply: (s) => s.replace(/(Duytai Downloader v)[0-9.]+( - macOS Setup)/, `$1${version}$2`),
  },
  {
    rel: 'extension/manifest.json',
    apply: (s) => s.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`),
  },
  {
    rel: 'android/app/build.gradle.kts',
    apply: (s) => s
      .replace(/(versionCode\s*=\s*)\d+/, `$1${versionCode}`)
      .replace(/(versionName\s*=\s*")[^"]+(")/, `$1${version}$2`),
  },
];

let drifted = [];
for (const t of targets) {
  const full = path.join(ROOT, t.rel);
  const before = fs.readFileSync(full, 'utf8');
  const after = t.apply(before);
  if (before !== after) {
    if (checkOnly) {
      drifted.push(t.rel);
    } else {
      fs.writeFileSync(full, after, 'utf8');
      console.log(`[SYNCED] ${t.rel} -> ${version} (${versionCode})`);
    }
  }
}

if (checkOnly) {
  if (drifted.length > 0) {
    console.error(`Version drift detected against package.json (${version}): ${drifted.join(', ')}`);
    process.exit(1);
  }
  console.log(`[OK] All 7 platform manifests match v${version} (code ${versionCode})`);
}
// [/VERIFIED-GOLDEN]
