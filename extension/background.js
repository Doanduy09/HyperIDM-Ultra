const API_BASE = 'http://127.0.0.1:17890';
const API_INTERCEPT = `${API_BASE}/api/intercept`;
const API_JOBS = `${API_BASE}/api/jobs`;
const API_HANDSHAKE = `${API_BASE}/api/auth/handshake`;
const EXT_RE = /\.(3gp|7z|aac|ace|aif|aiff|apk|apks|xapk|aab|ipa|arj|asf|avi|bin|bz2|tbz2|cab|crx|xpi|csv|dat|db|sqlite|deb|dmg|doc|docx|dwg|dxf|epub|mobi|azw3|esd|wim|swm|exe|f4v|ffu|flac|flv|fw|gz|gzip|tgz|hex|uf2|img|ipsw|iso|jar|war|jpg|jpeg|png|gif|webp|svg|avif|ico|bmp|json|xml|yaml|yml|lzh|lha|lz|lzma|tlz|m2ts|mts|m3u8|mpd|m4a|m4b|m4p|m4r|m4v|mkv|mov|mp2|mp3|mp4|mpa|mpe|mpeg|mpg|msi|msix|msu|nupkg|whl|odt|ods|odp|oga|ogg|ogv|opus|ota|ova|ovf|pak|par2|pdf|pkg|plj|pps|ppt|pptx|psd|ai|qcow2|qt|r\d{2,3}|ra|ram|rar|rm|rmvb|rom|rpm|appimage|rtf|s7z|sea|sit|sitx|sql|srt|ass|vtt|stl|tar|tif|tiff|torrent|ts|tsv|txt|vhd|vhdx|vmdk|vdi|vob|wav|webm|wma|wmv|xls|xlsx|xps|xz|txz|z|zip|zst|\d{3})(?:$|[?#])/i;
const MENU_ID = 'duytai-download';
const MENU_GRABBER_ID = 'duytai-grabber';

let cachedApiToken = '';

async function fetchWithTimeout(url, options = {}, timeoutMs = 3000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function queryNativeHost(payload) {
  return new Promise((resolve, reject) => {
    if (!chrome.runtime || typeof chrome.runtime.sendNativeMessage !== 'function') {
      return reject(new Error('NativeMessaging unavailable'));
    }
    try {
      chrome.runtime.sendNativeMessage('com.duytai.idm', payload, resp => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (resp && resp.ok) return resolve(resp);
        reject(new Error((resp && resp.error) || 'Native host failed'));
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function getApiToken(forceRefresh = false) {
  if (cachedApiToken && !forceRefresh) return cachedApiToken;
  try {
    const res = await fetchWithTimeout(API_HANDSHAKE, { method: 'POST' }, 2500);
    if (res.ok) {
      const data = await res.json();
      if (data && data.token) {
        cachedApiToken = String(data.token).trim();
        return cachedApiToken;
      }
    }
  } catch (_) {}
  try {
    const resp = await queryNativeHost({ action: 'get-token' });
    if (resp && resp.token) {
      cachedApiToken = String(resp.token).trim();
      return cachedApiToken;
    }
  } catch (_) {}
  return '';
}

async function enabled() {
  const { autoCapture = true } = await chrome.storage.local.get('autoCapture');
  return autoCapture;
}

async function buildHeaders(url, referrer, cookieStoreId) {
  const headers = { 'User-Agent': navigator.userAgent };
  if (referrer) headers.Referer = referrer;
  try {
    const query = { url };
    if (cookieStoreId) query.storeId = cookieStoreId;
    const cookies = await chrome.cookies.getAll(query);
    if (cookies.length) headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (_) {}
  return headers;
}

async function sendToDuytai(url, { referrer, fileName, source = 'Browser Extension', direct = false, cookieStoreId } = {}) {
  const headers = await buildHeaders(url, referrer, cookieStoreId);
  const endpoint = direct ? API_JOBS : API_INTERCEPT;
  const body = { url, maxConnections: 64, headers, source };
  if (fileName) body.fileName = fileName;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getApiToken(attempt > 0);
    const reqHeaders = { 'Content-Type': 'application/json' };
    if (token) reqHeaders['X-Duytai-Token'] = token;
    try {
      const res = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(body)
      }, 3500);
      if (res.ok) return res.json();
      if (res.status === 401 && attempt === 0) {
        cachedApiToken = '';
        continue;
      }
      if (res.status === 400 || res.status === 403) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      if (err && /HTTP 40[03]/.test(err.message)) throw err;
    }
  }

  // Fallback qua Native Messaging Host (kể cả khi Duytai đang đóng -> tự đánh thức Duytai!)
  if (!direct) {
    return queryNativeHost(body);
  }
  throw new Error('Duytai daemon unreachable');
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title, message
    });
  } catch (_) {}
}

async function handoff(url, opts) {
  try {
    await sendToDuytai(url, opts);
    return { ok: true };
  } catch (e) {
    notify('Duytai 64-Bit', 'Không kết nối được Duytai (127.0.0.1:17890). Hãy mở ứng dụng Duytai.');
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '⚡ Tải xuống bằng Duytai (64/128 Luồng)',
      contexts: ['link', 'video', 'audio', 'image', 'page']
    });
    chrome.contextMenus.create({
      id: MENU_GRABBER_ID,
      title: '🕷️ Tải tất cả liên kết trên trang với Duytai',
      contexts: ['page']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const cookieStoreId = tab && tab.cookieStoreId;
  if (info.menuItemId === MENU_ID) {
    const url = info.linkUrl || info.srcUrl || info.pageUrl;
    if (url) handoff(url, { referrer: tab && tab.url, cookieStoreId, source: 'Menu chuột phải Trình duyệt' });
  } else if (info.menuItemId === MENU_GRABBER_ID && tab && tab.url) {
    await getApiToken().catch(() => '');
    chrome.tabs.create({ url: `${API_BASE}/?grab=${encodeURIComponent(tab.url)}` });
  }
});

const recentHandoffs = new Map();
const bypassFallbackUrls = new Map();

function pruneMap(map, ttlMs) {
  const now = Date.now();
  for (const [k, ts] of map) {
    if (now - ts > ttlMs) map.delete(k);
  }
  return now;
}

function markRecentlyHandled(url) {
  const now = pruneMap(recentHandoffs, 4000);
  recentHandoffs.set(url, now);
}

function isRecentlyHandled(url) {
  pruneMap(recentHandoffs, 4000);
  return recentHandoffs.has(url);
}

function markBypassFallback(url) {
  const now = pruneMap(bypassFallbackUrls, 8000);
  bypassFallbackUrls.set(url, now);
}

function consumeBypassFallback(url) {
  pruneMap(bypassFallbackUrls, 8000);
  if (!bypassFallbackUrls.has(url)) return false;
  bypassFallbackUrls.delete(url);
  return true;
}

// Tier-2 Bắt link động / Meta-refresh: Pause ngay lập tức, chuyển sang Duytai rồi Cancel + Erase sạch khỏi lịch sử Chrome.
chrome.downloads.onCreated.addListener(async item => {
  if (!(await enabled())) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) return;
  if (consumeBypassFallback(url)) return;
  const isHtmlOnly = item.mime && /^(text\/html|application\/xhtml\+xml)$/i.test(item.mime) && !EXT_RE.test(url) && !EXT_RE.test(item.filename || '');
  if (isHtmlOnly) return;

  // Pause socket Chrome ngay lập tức để không tải song song tốn băng thông
  try { chrome.downloads.pause(item.id, () => {}); } catch (_) {}

  if (isRecentlyHandled(url)) {
    chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
    return;
  }

  const fname = item.filename ? item.filename.split(/[\\/]/).pop() : '';
  const r = await handoff(url, { referrer: item.referrer, fileName: fname, source: 'Tự động bắt link Trình duyệt' });
  if (r.ok) {
    markRecentlyHandled(url);
    chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
  } else {
    try { chrome.downloads.resume(item.id, () => {}); } catch (_) {}
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'get-token') {
    getApiToken(!!msg.refresh).then(token => sendResponse({ token })).catch(() => sendResponse({ token: '' }));
    return true;
  }
  if (msg && msg.type === 'download' && msg.url) {
    handoff(msg.url, {
      referrer: msg.referrer || (sender.tab && sender.tab.url),
      fileName: msg.fileName,
      cookieStoreId: sender.tab && sender.tab.cookieStoreId,
      source: msg.source || 'Thanh nổi Bắt Video/Link Duytai'
    }).then(r => {
      if (r.ok) {
        markRecentlyHandled(msg.url);
      } else if (msg.preClick) {
        markBypassFallback(msg.url);
      }
      sendResponse(r);
    });
    return true;
  }
});
