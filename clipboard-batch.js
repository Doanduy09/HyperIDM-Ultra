const { EventEmitter } = require('events');
const { exec } = require('child_process');
const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Simple Windows clipboard monitor using PowerShell.
 * Polls clipboard every 500ms and emits "url" when a new URL appears.
 * Supports batch expansion patterns like "file_[01-10].zip" and site grabber.
 */
class ClipboardBatchMonitor extends EventEmitter {
  constructor(pollInterval = 500) {
    super();
    this.pollInterval = pollInterval;
    this.lastText = '';
    this.timer = null;
  }

  // Start polling clipboard
  start() {
    if (this.timer) return; // already started
    this.timer = setInterval(() => this._checkClipboard(), this.pollInterval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _checkClipboard() {
    // Use PowerShell to read clipboard text
    exec('powershell -NoProfile -Command "Get-Clipboard -Raw"', (err, stdout) => {
      if (err) return; // ignore errors (e.g., non‑text clipboard)
      const text = stdout.trim();
      if (!text || text === this.lastText) return; // unchanged
      this.lastText = text;
      // If clipboard contains a URL, emit it
      const url = this._extractUrl(text);
      if (url) {
        this.emit('url', url);
        // If URL is a pattern, expand it
        if (this._hasRangePattern(url)) {
          const expanded = this._expandRange(url);
          for (const u of expanded) this.emit('url', u);
        }
        // If URL is a page, perform site grabber (simple)
        if (this._isHttpUrl(url)) {
          this._grabSiteLinks(url);
        }
      }
    });
  }

  _extractUrl(text) {
    // Simple URL regex (http/https)
    const match = /(https?:\/\/[^\s]+)/i.exec(text);
    return match ? match[1] : null;
  }

  _isHttpUrl(str) {
    return /^https?:\/\//i.test(str);
  }

  _hasRangePattern(str) {
    // Detect pattern like file_[01-10].zip
    return /\[\d+-\d+\]/.test(str);
  }

  _expandRange(pattern) {
    // Find the range and replace with each number padded to same width
    const rangeMatch = /\[(\d+)-(\d+)\]/.exec(pattern);
    if (!rangeMatch) return [];
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    const width = Math.max(rangeMatch[1].length, rangeMatch[2].length);
    const results = [];
    for (let i = start; i <= end; i++) {
      const num = i.toString().padStart(width, '0');
      results.push(pattern.replace(rangeMatch[0], num));
    }
    return results;
  }

  _grabSiteLinks(pageUrl) {
    const lib = pageUrl.startsWith('https') ? https : http;
    lib.get(pageUrl, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        // Very naive link extraction: look for href="..." containing http(s)
        const regex = /href=["']?(https?:\/\/[^"'\s>]+)["']?/gi;
        let m;
        while ((m = regex.exec(data)) !== null) {
          const link = m[1];
          // Emit only downloadable links (ends with common extensions) or media links
          if (/\.(zip|rar|7z|mp4|mkv|avi|mov|flv|webm|pdf|exe)(\?|$)/i.test(link) || /youtube\.com|youtu\.be/.test(link)) {
            this.emit('url', link);
          }
        }
      });
    }).on('error', () => { /* ignore network errors */ });
  }
}

module.exports = ClipboardBatchMonitor;
