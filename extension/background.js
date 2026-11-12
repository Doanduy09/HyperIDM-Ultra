const API = 'http://127.0.0.1:17890/api/jobs';
const EXT_RE = /\.(zip|rar|7z|tar|gz|bz2|xz|exe|msi|iso|ipsw|img|dmg|pkg|apk|deb|rpm|mp4|mkv|avi|mov|webm|mp3|flac|pdf)(?:$|[?#])/i;
const MIN_BYTES = 1024 * 1024;
const MENU_ID = 'hyperidm-download';

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

async function sendToHyper(url, { referrer, fileName } = {}) {
  const body = { url, maxConnections: 64, headers: await buildHeaders(url, referrer) };
  if (fileName) body.fileName = fileName;
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HyperIDM HTTP ${res.status}`);
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
    await sendToHyper(url, opts);
    return { ok: true };
  } catch (e) {
    notify('HyperIDM Ultra', 'Không kết nối được HyperIDM (127.0.0.1:17890). Hãy chạy HyperIDM trước.');
    return { ok: false, error: e.message };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '⚡ Tải siêu tốc bằng HyperIDM Ultra (64 Luồng)',
    contexts: ['link', 'video', 'audio', 'page']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const url = info.linkUrl || info.srcUrl || info.pageUrl;
  if (url) handoff(url, { referrer: tab && tab.url });
});

// Tự động bắt link: huỷ tải của trình duyệt và chuyển cho HyperIDM.
chrome.downloads.onCreated.addListener(async item => {
  if (!(await enabled())) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return;
  const bigEnough = item.fileSize > MIN_BYTES || item.totalBytes > MIN_BYTES;
  if (!EXT_RE.test(url) && !EXT_RE.test(item.filename || '') && !bigEnough) return;
  const r = await handoff(url, { referrer: item.referrer });
  if (r.ok) {
    chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'download' && msg.url) {
    handoff(msg.url, { referrer: msg.referrer || (sender.tab && sender.tab.url) }).then(sendResponse);
    return true;
  }
});
