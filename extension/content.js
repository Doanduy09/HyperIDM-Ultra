(() => {
  const ID = 'hyperidm-float-btn';
  const isVideoPage = () => {
    const { hostname, pathname } = location;
    if (/youtube\.com$/.test(hostname)) return pathname === '/watch' || pathname.startsWith('/shorts/');
    if (/youtu\.be$/.test(hostname)) return true;
    if (/ipsw\.me$/.test(hostname)) return true;
    return false;
  };

  function update() {
    const existing = document.getElementById(ID);
    if (!isVideoPage()) { if (existing) existing.remove(); return; }
    if (existing) return;

    const btn = document.createElement('button');
    btn.id = ID;
    btn.textContent = '⚡ Tải Video bằng HyperIDM Ultra';
    btn.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:24px', 'z-index:2147483647',
      'padding:12px 20px', 'border:0', 'border-radius:999px', 'cursor:pointer',
      'font:600 14px/1 system-ui,Segoe UI,sans-serif', 'color:#fff',
      'background:linear-gradient(135deg,#6a5cff,#00c6ff)',
      'box-shadow:0 8px 24px rgba(0,120,255,.45)', 'transition:transform .15s'
    ].join(';');
    btn.onmouseenter = () => (btn.style.transform = 'scale(1.06)');
    btn.onmouseleave = () => (btn.style.transform = '');
    btn.onclick = () => {
      btn.textContent = '⏳ Đang gửi...';
      chrome.runtime.sendMessage({ type: 'download', url: location.href, referrer: location.href }, r => {
        btn.textContent = r && r.ok ? '✅ Đã gửi tới HyperIDM' : '❌ HyperIDM chưa chạy';
        setTimeout(() => (btn.textContent = '⚡ Tải Video bằng HyperIDM Ultra'), 2500);
      });
    };
    document.body.appendChild(btn);
  }

  update();
  // YouTube là SPA: kiểm tra lại khi điều hướng.
  window.addEventListener('yt-navigate-finish', update);
  setInterval(update, 1500);
})();
