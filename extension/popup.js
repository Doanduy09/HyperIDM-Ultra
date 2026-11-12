const API = 'http://127.0.0.1:17890/api/jobs';
const $ = id => document.getElementById(id);

chrome.storage.local.get('autoCapture').then(({ autoCapture = true }) => {
  $('auto').checked = autoCapture;
});
$('auto').onchange = e => chrome.storage.local.set({ autoCapture: e.target.checked });

async function refresh() {
  try {
    const { jobs } = await (await fetch(API)).json();
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
  }
}
refresh();
setInterval(refresh, 1000);
