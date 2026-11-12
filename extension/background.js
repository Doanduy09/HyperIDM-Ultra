const API_INTERCEPT = 'http://127.0.0.1:17890/api/intercept';
const API_JOBS = 'http://127.0.0.1:17890/api/jobs';
const EXT_RE = /\.(3gp|7z|aac|ace|aif|aiff|apk|apks|xapk|aab|ipa|arj|asf|avi|bin|bz2|tbz2|cab|crx|xpi|csv|dat|db|sqlite|deb|dmg|doc|docx|dwg|dxf|epub|mobi|azw3|esd|wim|swm|exe|f4v|ffu|flac|flv|fw|gz|gzip|tgz|hex|uf2|img|ipsw|iso|jar|war|jpg|jpeg|png|gif|webp|svg|avif|ico|bmp|json|xml|yaml|yml|lzh|lha|lz|lzma|tlz|m2ts|mts|m3u8|mpd|m4a|m4b|m4p|m4r|m4v|mkv|mov|mp2|mp3|mp4|mpa|mpe|mpeg|mpg|msi|msix|msu|nupkg|whl|odt|ods|odp|oga|ogg|ogv|opus|ota|ova|ovf|pak|par2|pdf|pkg|plj|pps|ppt|pptx|psd|ai|qcow2|qt|r\d{2,3}|ra|ram|rar|rm|rmvb|rom|rpm|appimage|rtf|s7z|sea|sit|sitx|sql|srt|ass|vtt|stl|tar|tif|tiff|torrent|ts|tsv|txt|vhd|vhdx|vmdk|vdi|vob|wav|webm|wma|wmv|xls|xlsx|xps|xz|txz|z|zip|zst|\d{3})(?:$|[?#])/i;
const MENU_ID = 'duytai-download';
const MENU_GRABBER_ID = 'duytai-grabber';

async function enabled() {
  const { autoCapture = true } = await chrome.storage.local.get('autoCapture');
  return autoCapture;
}

async function buildHeaders(url, referrer) {
  const headers = { 'User-Agent': navigator.userAgent };
  if (referrer) headers.Referer = referrer;
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length) headers.Cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } catch (_) {}
  return headers;
}

async function sendToDuytai(url, { referrer, fileName, source = 'Browser Extension', direct = false } = {}) {
  const headers = await buildHeaders(url, referrer);
  const endpoint = direct ? API_JOBS : API_INTERCEPT;
  const body = { url, maxConnections: 64, headers, source };
  if (fileName) body.fileName = fileName;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Duytai HTTP ${res.status}`);
  return res.json();
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    title, message
  });
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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) {
    const url = info.linkUrl || info.srcUrl || info.pageUrl;
    if (url) handoff(url, { referrer: tab && tab.url, source: 'Menu chuột phải Trình duyệt' });
  } else if (info.menuItemId === MENU_GRABBER_ID && tab && tab.url) {
    handoff(tab.url, { referrer: tab.url, source: 'Duytai Site Grabber' });
  }
});

const recentHandoffs = new Map();
function isRecentlyHandled(url) {
  const now = Date.now();
  for (const [k, ts] of recentHandoffs) {
    if (now - ts > 4000) recentHandoffs.delete(k);
  }
  if (recentHandoffs.has(url)) return true;
  recentHandoffs.set(url, now);
  return false;
}

// Tier-2 Bắt link động / Meta-refresh: Pause ngay lập tức, chuyển sang Duytai rồi Cancel + Erase sạch khỏi lịch sử Chrome.
chrome.downloads.onCreated.addListener(async item => {
  if (!(await enabled())) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url)) return;
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
    chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
  } else {
    try { chrome.downloads.resume(item.id, () => {}); } catch (_) {}
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'download' && msg.url) {
    isRecentlyHandled(msg.url);
    handoff(msg.url, {
      referrer: msg.referrer || (sender.tab && sender.tab.url),
      fileName: msg.fileName,
      source: msg.source || 'Thanh nổi Bắt Video/Link Duytai'
    }).then(sendResponse);
    return true;
  }
});
