/* QuizClash shared browser helpers: MQTT transport, QR rendering, UI utils. */
(function () {
  'use strict';

  const BROKER = 'wss://broker.emqx.io:8084/mqtt';

  function createClient(role) {
    const clientId = 'qc_' + role + '_' + Math.random().toString(36).slice(2, 10);
    return mqtt.connect(BROKER, {
      clientId: clientId,
      clean: true,
      protocolVersion: 4,
      keepalive: 30,
      reconnectPeriod: 1500,
      connectTimeout: 12000,
    });
  }

  function setStatus(el, kind, text) {
    if (!el) return;
    el.classList.remove('live', 'off');
    if (kind) el.classList.add(kind);
    const label = el.querySelector('em');
    if (label && text) label.textContent = text;
  }

  /** Crisp inline SVG QR code — no images, no extra network calls. */
  function renderQR(svg, text, dark) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2;
    const size = n + quiet * 2;
    let path = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) path += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
      }
    }
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '加入遊戲的 QR code');
    svg.innerHTML =
      '<rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + path + '" fill="' + (dark || '#12122b') + '"/>';
  }

  let toastTimer = null;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(function () { el.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { toast('已複製'); });
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已複製'); } catch (e) { toast('複製失敗，請手動選取'); }
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Shrink an uploaded image to a sane payload size before it goes over MQTT. */
  function compressImage(file, maxW, quality) {
    const w = maxW || 900;
    const q = quality || 0.72;
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('讀取圖片失敗')); };
      reader.onload = function () {
        const img = new Image();
        img.onerror = function () { reject(new Error('圖片格式不支援')); };
        img.onload = function () {
          const scale = Math.min(1, w / img.width);
          const cw = Math.max(1, Math.round(img.width * scale));
          const ch = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          resolve(canvas.toDataURL('image/jpeg', q));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { return false; }
  }

  function param(name) {
    return new URLSearchParams(location.search).get(name);
  }

  window.Net = {
    BROKER: BROKER,
    createClient: createClient,
    setStatus: setStatus,
    renderQR: renderQR,
    toast: toast,
    copy: copy,
    download: download,
    el: el,
    compressImage: compressImage,
    load: load,
    save: save,
    param: param,
  };
})();
