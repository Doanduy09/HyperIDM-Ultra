(() => {
  const ID = 'duytai-float-btn';
  const detectDownloadablePage = () => {
    const { hostname, pathname } = location;
    if (/youtube\.com$/.test(hostname)) return pathname === '/watch' || pathname.startsWith('/shorts/');
    if (/youtu\.be$|tiktok\.com$|vimeo\.com$|bilibili\.com$|dailymotion\.com$|ipsw\.me$|sourceforge\.net$|mediafire\.com$/.test(hostname)) return true;
    const v = document.querySelector('video[src], video source[src], audio[src]');
    return !!v;
  };

  function resolveTargetUrl() {
    const v = document.querySelector('video[src], video source[src]');
    if (v && v.src && /^https?:/i.test(v.src)) return v.src;
    return location.href;
  }

  function update() {
    const existing = document.getElementById(ID);
    if (!detectDownloadablePage()) { if (existing) existing.remove(); return; }
    if (existing) return;

    const btn = document.createElement('button');
    btn.id = ID;
    btn.textContent = '⚡ Tải video/tệp này bằng Duytai';
    btn.style.cssText = [
      'position:fixed', 'right:20px', 'bottom:24px', 'z-index:2147483647',
      'padding:10px 18px', 'border:1px solid rgba(255,255,255,0.25)', 'border-radius:999px', 'cursor:pointer',
      'font:600 13px/1 Segoe UI,system-ui,sans-serif', 'color:#fff',
      'background:linear-gradient(135deg,#0d9488,#0284c7)',
      'box-shadow:0 8px 24px rgba(2,132,199,.45)', 'transition:transform .15s'
    ].join(';');
    btn.onmouseenter = () => (btn.style.transform = 'scale(1.05)');
    btn.onmouseleave = () => (btn.style.transform = '');
    btn.onclick = () => {
      btn.textContent = '⏳ Đang gửi sang Duytai...';
      const targetUrl = resolveTargetUrl();
      chrome.runtime.sendMessage({ type: 'download', url: targetUrl, referrer: location.href, source: 'Thanh nổi Video Duytai' }, r => {
        btn.textContent = r && r.ok ? '✅ Đã bật hộp thoại Duytai!' : '❌ Duytai chưa chạy';
        setTimeout(() => (btn.textContent = '⚡ Tải video/tệp này bằng Duytai'), 2500);
      });
    };
    document.body.appendChild(btn);
  }

  update();
  window.addEventListener('yt-navigate-finish', update);
  setInterval(update, 1800);
})();
