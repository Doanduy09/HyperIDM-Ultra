(() => {
  if (window.__duytaiHooked) return;
  window.__duytaiHooked = true;

  const EXT_RE = /\.(3gp|3g2|7z|aac|ace|aif|aiff|alac|apk|apks|xapk|aab|ipa|arj|asf|avi|bin|bz2|tbz2|cab|crx|xpi|csv|dat|db|sqlite|deb|dmg|doc|docx|dwg|dxf|epub|mobi|azw3|esd|wim|swm|exe|f4v|ffu|flac|flv|fw|gz|gzip|tgz|hex|uf2|img|ipsw|iso|jar|war|lzh|lha|lz|lzma|tlz|m2ts|mts|m3u8|mpd|m4a|m4b|m4p|m4r|m4v|mkv|mov|mp2|mp3|mp4|mpa|mpe|mpeg|mpg|msi|msix|msixbundle|appx|msu|nupkg|whl|odt|ods|odp|oga|ogg|ogv|opus|ota|ova|ovf|pak|par2|pdf|pkg|plj|pps|ppsx|ppt|pptx|psd|ai|qcow2|qt|r\d{2,3}|ra|ram|rar|rm|rmvb|rom|rpm|appimage|rtf|s7z|sea|sit|sitx|sql|tar|tif|tiff|torrent|ts|tsv|vhd|vhdx|vmdk|vdi|vob|wav|webm|wma|wmv|xls|xlsx|xps|xz|txz|z|zip|zst)(?:$|[?#&])/i;
  const DIRECT_DOWNLOAD_RE = /^https?:\/\/(?:(?:www\.)?ipsw\.me\/download\/|updates\.cdn-apple\.com\/|appldnld\.apple\.com\/|github\.com\/[^/]+\/[^/]+\/releases\/download\/|objects\.githubusercontent\.com\/|huggingface\.co\/.+\/resolve\/|drive\.usercontent\.google\.com\/download|drive\.google\.com\/uc\?|mediafire\.com\/file\/|sourceforge\.net\/projects\/.+\/download|download\.microsoft\.com\/)/i;

  const PLATFORM_VIDEO_HOST_RE = /(?:^|\.)(youtube\.com|youtu\.be|tiktok\.com|vimeo\.com|bilibili\.com|dailymotion\.com|twitch\.tv|facebook\.com|fb\.watch|instagram\.com)$/i;

  let autoCaptureEnabled = true;
  try {
    chrome.storage.local.get('autoCapture', res => {
      if (res && typeof res.autoCapture === 'boolean') autoCaptureEnabled = res.autoCapture;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.autoCapture) {
        autoCaptureEnabled = changes.autoCapture.newValue !== false;
      }
    });
  } catch (_) {}

  // Tier-1 Pre-Click Capture: intercept link BEFORE Chrome initiates HTTP download (no "Đã hủy" bubble)
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !autoCaptureEnabled) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const anchor = e.target && e.target.closest ? e.target.closest('a[href], area[href]') : null;
    if (!anchor) return;
    if (anchor.dataset && anchor.dataset.duytaiBypass === '1') {
      delete anchor.dataset.duytaiBypass;
      return;
    }
    const href = anchor.href;
    if (!href || !/^https?:/i.test(href)) return;
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(href)) return;

    const hasDownloadAttr = anchor.hasAttribute('download');
    if (!hasDownloadAttr && !EXT_RE.test(href) && !DIRECT_DOWNLOAD_RE.test(href)) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const dlAttr = (anchor.getAttribute('download') || '').trim();
    const fallbackNative = () => {
      try {
        if (anchor.isConnected) {
          anchor.dataset.duytaiBypass = '1';
          anchor.click();
          return;
        }
      } catch (_) {}
      location.href = href;
    };
    try {
      chrome.runtime.sendMessage({
        type: 'download',
        url: href,
        referrer: location.href,
        fileName: dlAttr,
        preClick: true,
        source: 'Bắt trước khi Chrome tải (Pre-Click)'
      }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          fallbackNative();
        }
      });
    } catch (_) {
      fallbackNative();
    }
  }, true);

  if (window !== window.top) return;

  const WIDGET_ID = 'duytai-float-widget';
  const BUBBLE_ID = 'duytai-float-bubble';
  let showFloatBtn = true;

  try {
    chrome.storage.local.get('showFloatBtn', res => {
      if (res && typeof res.showFloatBtn === 'boolean') showFloatBtn = res.showFloatBtn;
      if (!showFloatBtn) removeWidget();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.showFloatBtn) {
        showFloatBtn = changes.showFloatBtn.newValue !== false;
        if (!showFloatBtn) removeWidget();
        else update();
      }
    });
  } catch (_) {}

  function removeWidget() {
    const w = document.getElementById(WIDGET_ID);
    if (w) w.remove();
    const b = document.getElementById(BUBBLE_ID);
    if (b) b.remove();
    const old = document.getElementById('duytai-float-btn');
    if (old) old.remove();
  }

  function isDismissed() {
    try {
      return sessionStorage.getItem('duytai_float_dismissed') === '1';
    } catch (_) {
      return false;
    }
  }

  function isMinimized() {
    try {
      return sessionStorage.getItem('duytai_float_minimized') === '1';
    } catch (_) {
      return false;
    }
  }

  const detectDownloadablePage = () => {
    const { hostname, pathname } = location;
    // Facebook / Messenger: NEVER show on news feed, home or chat dock; ONLY on dedicated video/watch/reel pages
    if (/(?:^|\.)facebook\.com$/.test(hostname) || /(?:^|\.)messenger\.com$/.test(hostname)) {
      return pathname.startsWith('/watch') || pathname.startsWith('/reel') || pathname.includes('/videos/') || pathname.includes('/video/') || location.search.includes('v=');
    }
    if (/youtube\.com$/.test(hostname)) return pathname === '/watch' || pathname.startsWith('/shorts/');
    if (/youtu\.be$|tiktok\.com$|vimeo\.com$|bilibili\.com$|dailymotion\.com$|ipsw\.me$|sourceforge\.net$|mediafire\.com$/.test(hostname)) return true;
    const v = document.querySelector('video[src], video source[src], audio[src]');
    return !!v;
  };

  function resolveTargetUrl() {
    if (PLATFORM_VIDEO_HOST_RE.test(location.hostname)) return location.href;
    const v = document.querySelector('video[src], video source[src]');
    if (v && v.src && /^https?:/i.test(v.src)) return v.src;
    return location.href;
  }

  function showMiniBubble(topPx) {
    if (document.getElementById(BUBBLE_ID)) return;
    const w = document.getElementById(WIDGET_ID);
    if (w) w.remove();

    const bubble = document.createElement('div');
    bubble.id = BUBBLE_ID;
    bubble.title = '⚡ Duytai: Bấm hoặc di chuột để mở thanh tải';
    bubble.textContent = '⚡';
    bubble.style.cssText = [
      'position:fixed', `top:${topPx || 80}px`, 'right:8px',
      'width:34px', 'height:34px', 'border-radius:50%', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:linear-gradient(135deg,#0d9488,#0284c7)',
      'box-shadow:0 4px 16px rgba(2,132,199,0.5)',
      'border:2px solid rgba(255,255,255,0.4)',
      'color:#fff', 'font:700 16px system-ui,sans-serif',
      'cursor:pointer', 'user-select:none', 'transition:transform .15s, box-shadow .15s'
    ].join(';');

    bubble.onmouseenter = () => (bubble.style.transform = 'scale(1.15)');
    bubble.onmouseleave = () => (bubble.style.transform = 'scale(1)');
    bubble.onclick = (e) => {
      e.stopPropagation();
      try { sessionStorage.removeItem('duytai_float_minimized'); } catch (_) {}
      bubble.remove();
      update();
    };
    document.body.appendChild(bubble);
  }

  function triggerDownload(quality, btnElement, defaultLabel) {
    btnElement.textContent = '⏳ Đang gửi...';
    const targetUrl = resolveTargetUrl();
    chrome.runtime.sendMessage({
      type: 'download',
      url: targetUrl,
      referrer: location.href,
      origin: location.origin,
      videoQuality: quality || 'best',
      source: quality === 'audio' ? 'Thanh nổi Duytai (Chỉ Audio)' : 'Thanh nổi Duytai (Video)'
    }, r => {
      btnElement.textContent = r && r.ok ? '✅ Đã mở Duytai!' : '❌ Duytai chưa chạy';
      setTimeout(() => (btnElement.textContent = defaultLabel), 2200);
    });
  }

  function update() {
    // 1. Always purge legacy static bottom-right button if present
    const oldBtn = document.getElementById('duytai-float-btn');
    if (oldBtn) oldBtn.remove();

    // 2. Check if disabled or dismissed by user
    if (document.hidden || !document.body || !showFloatBtn || isDismissed()) {
      if (!showFloatBtn || isDismissed()) removeWidget();
      return;
    }

    // 3. Check page context
    if (!detectDownloadablePage()) {
      removeWidget();
      return;
    }

    // 4. Restore user dragged position
    let savedPos = null;
    try {
      savedPos = JSON.parse(localStorage.getItem('duytai_float_pos') || 'null');
    } catch (_) {}
    const topCoord = savedPos ? savedPos.top : 80;

    // 5. Handle Minimized Dock State
    if (isMinimized()) {
      showMiniBubble(topCoord);
      return;
    }

    if (document.getElementById(WIDGET_ID)) return;
    const existingBubble = document.getElementById(BUBBLE_ID);
    if (existingBubble) existingBubble.remove();

    // 6. Create movable, minimizable & dismissible widget
    const widget = document.createElement('div');
    widget.id = WIDGET_ID;

    widget.style.cssText = [
      'position:fixed',
      savedPos ? `top:${savedPos.top}px` : 'top:80px',
      savedPos ? `left:${savedPos.left}px` : 'right:20px',
      'z-index:2147483647',
      'display:inline-flex', 'align-items:center',
      'padding:3px 8px 3px 12px',
      'border:1px solid rgba(255,255,255,0.3)', 'border-radius:999px',
      'font:600 13px/1 Segoe UI,system-ui,sans-serif', 'color:#fff',
      'background:linear-gradient(135deg,#0d9488,#0284c7)',
      'box-shadow:0 8px 24px rgba(2,132,199,.45)',
      'user-select:none', 'cursor:grab', 'touch-action:none',
      'transition:box-shadow .2s, transform .15s'
    ].join(';');

    // Drag handle icon
    const grip = document.createElement('span');
    grip.textContent = '⋮⋮';
    grip.title = 'Giữ và kéo để di chuyển nút';
    grip.style.cssText = 'opacity:0.65;margin-right:6px;cursor:grab;font-size:13px;display:inline-flex;align-items:center;';

    // Download action button (Video)
    const btn = document.createElement('span');
    btn.textContent = '⚡ Tải video bằng Duytai';
    btn.title = 'Bấm để tải video chất lượng cao nhất qua Duytai 64-Bit';
    btn.style.cssText = 'cursor:pointer;padding:6px 2px;display:inline-flex;align-items:center;';

    // Secondary Audio-only button for video platforms
    const isVideoSite = PLATFORM_VIDEO_HOST_RE.test(location.hostname) || !!document.querySelector('video');
    let audioBtn = null;
    let divider = null;
    if (isVideoSite) {
      divider = document.createElement('span');
      divider.textContent = '|';
      divider.style.cssText = 'opacity:0.35;margin:0 6px;font-size:12px;user-select:none;';

      audioBtn = document.createElement('span');
      audioBtn.textContent = '🎵 Nhạc MP3';
      audioBtn.title = 'Chỉ tải âm thanh MP3/M4A 320kbps siêu nhẹ';
      audioBtn.style.cssText = 'cursor:pointer;padding:6px 2px;opacity:0.92;display:inline-flex;align-items:center;font-size:12px;';
      audioBtn.onmouseenter = () => (audioBtn.style.opacity = '1');
      audioBtn.onmouseleave = () => (audioBtn.style.opacity = '0.92');
    }

    // Minimize button (—) -> shrinks into Mini-Dock Bubble
    const minBtn = document.createElement('button');
    minBtn.textContent = '—';
    minBtn.title = 'Thu nhỏ thành chấm tròn (Mini Dock)';
    minBtn.style.cssText = [
      'cursor:pointer', 'border:none', 'outline:none',
      'background:rgba(255,255,255,0.22)', 'color:#ffffff',
      'width:20px', 'height:20px', 'border-radius:50%', 'margin-left:8px',
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'font:700 11px/1 sans-serif', 'padding:0', 'flex-shrink:0',
      'transition:background .15s, transform .15s'
    ].join(';');
    minBtn.onmouseenter = () => {
      minBtn.style.background = 'rgba(255,255,255,0.45)';
      minBtn.style.transform = 'scale(1.15)';
    };
    minBtn.onmouseleave = () => {
      minBtn.style.background = 'rgba(255,255,255,0.22)';
      minBtn.style.transform = 'scale(1)';
    };
    minBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      try { sessionStorage.setItem('duytai_float_minimized', '1'); } catch (_) {}
      const rect = widget.getBoundingClientRect();
      widget.remove();
      showMiniBubble(Math.round(rect.top));
    };

    // Close / Dismiss button (×)
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = 'Ẩn nút này (Không hiện lại trên trang này)';
    closeBtn.style.cssText = [
      'cursor:pointer', 'border:none', 'outline:none',
      'background:rgba(255,255,255,0.22)', 'color:#ffffff',
      'width:20px', 'height:20px', 'border-radius:50%', 'margin-left:6px',
      'display:inline-flex', 'align-items:center', 'justify-content:center',
      'font:700 15px/1 sans-serif', 'padding:0', 'flex-shrink:0',
      'transition:background .15s, transform .15s'
    ].join(';');

    closeBtn.onmouseenter = () => {
      closeBtn.style.background = '#ef4444';
      closeBtn.style.transform = 'scale(1.15)';
    };
    closeBtn.onmouseleave = () => {
      closeBtn.style.background = 'rgba(255,255,255,0.22)';
      closeBtn.style.transform = 'scale(1)';
    };
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      try { sessionStorage.setItem('duytai_float_dismissed', '1'); } catch (_) {}
      removeWidget();
    };

    // Smooth dragging with pointer events attached to window
    let isDragging = false;
    let startX = 0, startY = 0;
    let origTop = 0, origLeft = 0;
    let moved = false;

    const onPointerMove = (me) => {
      if (!isDragging) return;
      const dx = me.clientX - startX;
      const dy = me.clientY - startY;
      if (Math.hypot(dx, dy) > 3) moved = true;
      const maxTop = window.innerHeight - widget.offsetHeight - 10;
      const maxLeft = window.innerWidth - widget.offsetWidth - 10;
      const newTop = Math.max(10, Math.min(maxTop, origTop + dy));
      const newLeft = Math.max(10, Math.min(maxLeft, origLeft + dx));
      widget.style.top = newTop + 'px';
      widget.style.left = newLeft + 'px';
      widget.style.right = 'auto';
      widget.style.bottom = 'auto';
    };

    const onPointerUp = () => {
      if (!isDragging) return;
      isDragging = false;
      widget.style.cursor = 'grab';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (moved) {
        try {
          const rect = widget.getBoundingClientRect();
          localStorage.setItem('duytai_float_pos', JSON.stringify({
            top: Math.round(rect.top),
            left: Math.round(rect.left)
          }));
        } catch (_) {}
      }
    };

    widget.addEventListener('pointerdown', (e) => {
      if (e.target === closeBtn || closeBtn.contains(e.target) || e.target === minBtn || minBtn.contains(e.target)) return;
      isDragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = widget.getBoundingClientRect();
      origTop = rect.top;
      origLeft = rect.left;
      widget.style.cursor = 'grabbing';
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    });

    btn.onclick = (e) => {
      if (moved) return;
      e.stopPropagation();
      triggerDownload('best', btn, '⚡ Tải video bằng Duytai');
    };

    if (audioBtn) {
      audioBtn.onclick = (e) => {
        if (moved) return;
        e.stopPropagation();
        triggerDownload('audio', audioBtn, '🎵 Nhạc MP3');
      };
    }

    widget.appendChild(grip);
    widget.appendChild(btn);
    if (divider && audioBtn) {
      widget.appendChild(divider);
      widget.appendChild(audioBtn);
    }
    widget.appendChild(minBtn);
    widget.appendChild(closeBtn);
    document.body.appendChild(widget);
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', update, { once: true });
  } else {
    update();
  }
  window.addEventListener('yt-navigate-finish', update);
  setInterval(update, 2000);
})();
