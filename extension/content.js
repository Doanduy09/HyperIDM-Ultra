(() => {
  if (window.__duytaiHooked) return;
  window.__duytaiHooked = true;

  const EXT_RE = /\.(3gp|3g2|7z|aac|ace|aif|aiff|alac|apk|apks|xapk|aab|ipa|arj|asf|avi|bin|bz2|tbz2|cab|crx|xpi|csv|dat|db|sqlite|deb|dmg|doc|docx|dwg|dxf|epub|mobi|azw3|esd|wim|swm|exe|f4v|ffu|flac|flv|fw|gz|gzip|tgz|hex|uf2|img|ipsw|iso|jar|war|lzh|lha|lz|lzma|tlz|m2ts|mts|m3u8|mpd|m4a|m4b|m4p|m4r|m4v|mkv|mov|mp2|mp3|mp4|mpa|mpe|mpeg|mpg|msi|msix|msixbundle|appx|msu|nupkg|whl|odt|ods|odp|oga|ogg|ogv|opus|ota|ova|ovf|pak|par2|pdf|pkg|plj|pps|ppsx|ppt|pptx|psd|ai|qcow2|qt|r\d{2,3}|ra|ram|rar|rm|rmvb|rom|rpm|appimage|rtf|s7z|sea|sit|sitx|sql|tar|tif|tiff|torrent|ts|tsv|vhd|vhdx|vmdk|vdi|vob|wav|webm|wma|wmv|xls|xlsx|xps|xz|txz|z|zip|zst)(?:$|[?#&])/i;
  const DIRECT_DOWNLOAD_RE = /^https?:\/\/(?:(?:www\.)?ipsw\.me\/download\/|updates\.cdn-apple\.com\/|appldnld\.apple\.com\/|github\.com\/[^/]+\/[^/]+\/releases\/download\/|objects\.githubusercontent\.com\/|huggingface\.co\/.+\/resolve\/|drive\.usercontent\.google\.com\/download|drive\.google\.com\/uc\?|mediafire\.com\/file\/|sourceforge\.net\/projects\/.+\/download|download\.microsoft\.com\/)/i;

  // Tier-1 Pre-Click Capture: intercept link BEFORE Chrome initiates HTTP download (no "Đã hủy" bubble)
  document.addEventListener('click', (e) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const anchor = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
    if (!anchor) return;
    const href = anchor.href;
    if (!href || !/^https?:/i.test(href)) return;
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(href)) return;

    const hasDownloadAttr = anchor.hasAttribute('download');
    if (!hasDownloadAttr && !EXT_RE.test(href) && !DIRECT_DOWNLOAD_RE.test(href)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const dlAttr = (anchor.getAttribute('download') || '').trim();
    try {
      chrome.runtime.sendMessage({
        type: 'download',
        url: href,
        referrer: location.href,
        fileName: dlAttr,
        source: 'Bắt trước khi Chrome tải (Pre-Click)'
      }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          location.href = href;
        }
      });
    } catch (_) {
      location.href = href;
    }
  }, true);

  if (window !== window.top) return;

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
    if (!document.body) return;
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

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', update, { once: true });
  } else {
    update();
  }
  window.addEventListener('yt-navigate-finish', update);
  setInterval(update, 1800);
})();
