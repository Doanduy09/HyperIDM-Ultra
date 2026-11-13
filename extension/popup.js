const API = 'http://127.0.0.1:17890/api/jobs';
const $ = id => document.getElementById(id);

chrome.storage.local.get('autoCapture').then(({ autoCapture = true }) => {
  $('auto').checked = autoCapture;
});
$('auto').onchange = e => chrome.storage.local.set({ autoCapture: e.target.checked });

let cachedToken = '';
let inFlight = false;

async function getToken(refreshToken = false) {
  if (cachedToken && !refreshToken) return cachedToken;
  const resp = await chrome.runtime.sendMessage({ type: 'get-token', refresh: refreshToken }).catch(() => ({}));
  cachedToken = (resp && resp.token) || '';
  return cachedToken;
}

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  try {
    let token = await getToken(false);
    let res = await fetch(API, { headers: token ? { 'X-Duytai-Token': token } : {} });
    if (res.status === 401) {
      token = await getToken(true);
      res = await fetch(API, { headers: token ? { 'X-Duytai-Token': token } : {} });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { jobs = [] } = await res.json();
    $('off').hidden = true;
    const active = jobs.filter(j => j.status === 'downloading');
    const bps = active.reduce((s, j) => s + (j.currentSpeedBps || 0), 0);
    $('speed').textContent = (bps / 1048576).toFixed(2) + ' MB/s';
    $('jobs').innerHTML = '';
    for (const j of active.slice(0, 5)) {
      const d = document.createElement('div');
      d.className = 'job';
      const name = document.createElement('div');
      name.textContent = `${j.fileName} — ${j.progress}%`;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = j.progress + '%';
      bar.appendChild(fill);
      d.append(name, bar);
      $('jobs').appendChild(d);
    }
  } catch (_) {
    $('off').hidden = false;
    $('speed').textContent = '0 MB/s';
    $('jobs').innerHTML = '';
  } finally {
    inFlight = false;
  }
}
refresh();
setInterval(refresh, 1000);
