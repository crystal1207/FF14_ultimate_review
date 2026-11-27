'use strict';
// 讀取畫面時鐘的數字（OCR）。只在影片還沒有任何校正時用來讀出大概的時間。
// 讀取畫面時鐘自動校正：
// 1. 使用者框選影片右上角「本」時鐘的位置（存成相對於播放器的比例，之後記住）
// 2. 用瀏覽器的「分享分頁」拿到這個分頁的畫面（網頁不能直接讀 YouTube 播放器的像素）
// 3. 控制播放器跳到不同時間，用 OCR（tesseract.js）讀出 HH:MM，找出時鐘跳分鐘的那一刻
// 4. 那一刻的影片秒數 ＝ 新分鐘的 :00，得到精確的校正點

window.ClockOCR = (() => {
  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
  let worker = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('載入 OCR 元件失敗，請確認網路連線'));
      document.head.appendChild(s);
    });
  }

  async function getWorker() {
    if (worker) return worker;
    await loadScript(TESSERACT_URL);
    worker = await Tesseract.createWorker('eng');
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789:',
      tessedit_pageseg_mode: '7', // 單行文字
    });
    return worker;
  }

  // 把時鐘區域放大、轉灰階、拉高對比、二值化成黑字白底，再裁掉多餘的空白，讓 OCR 比較好讀。
  // 時鐘可能是亮字也可能很暗（暗場景、半透明 UI），所以門檻依畫面自動決定；字的像素一定比背景少。
  // shift：門檻往上／往下調整的比例（讀不出來時換個門檻再試）
  function preprocess(src, sx, sy, sw, sh, shift = 0) {
    const scale = Math.max(1, 72 / sh);
    const w = Math.round(sw * scale);
    const h = Math.round(sh * scale);
    const c0 = document.createElement('canvas');
    c0.width = w;
    c0.height = h;
    const g0 = c0.getContext('2d', { willReadFrequently: true });
    g0.imageSmoothingEnabled = true;
    g0.imageSmoothingQuality = 'high';
    g0.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    const d = g0.getImageData(0, 0, w, h).data;
    const n = w * h;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) gray[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
    // 對比拉到 0～255（用 2% 與 99.5% 的亮度，避免單一雜點影響）
    const sorted = Float32Array.from(gray).sort();
    const lo = sorted[Math.floor(n * 0.02)];
    const hi = sorted[Math.min(n - 1, Math.floor(n * 0.995))];
    const range = Math.max(1, hi - lo);
    const hist = new Array(256).fill(0);
    const v8 = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      v8[i] = Math.max(0, Math.min(255, ((gray[i] - lo) / range) * 255));
      hist[v8[i]]++;
    }
    let th = otsu(hist, n);
    th = Math.max(1, Math.min(254, th + shift * 255));
    let bright = 0;
    for (let i = 0; i < n; i++) if (v8[i] > th) bright++;
    const textIsBright = bright < n / 2;
    const isText = (i) => (textIsBright ? v8[i] > th : v8[i] <= th);
    // 裁到字的範圍
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!isText(y * w + x)) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
    const pad = 16;
    const c = document.createElement('canvas');
    c.width = x1 - x0 + 1 + pad * 2;
    c.height = y1 - y0 + 1 + pad * 2;
    const g = c.getContext('2d');
    const out = g.createImageData(c.width, c.height);
    out.data.fill(255);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!isText(y * w + x)) continue;
        const o = ((y - y0 + pad) * c.width + (x - x0 + pad)) * 4;
        out.data[o] = out.data[o + 1] = out.data[o + 2] = 0;
      }
    }
    g.putImageData(out, 0, 0);
    return c;
  }

  function otsu(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, th = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; th = i; }
    }
    return th;
  }

  // OCR 結果 → { h, m }；讀不出來回傳 null
  function parseClock(text) {
    const t = (text || '').replace(/\s/g, '');
    let m = t.match(/(\d{1,2}):(\d{2})(?!.*\d{1,2}:\d{2})/);
    let hh, mm;
    if (m) { hh = +m[1]; mm = +m[2]; }
    else {
      const digits = t.replace(/\D/g, '');
      if (digits.length < 3 || digits.length > 4) return null;
      hh = +digits.slice(0, -2); mm = +digits.slice(-2);
    }
    if (hh > 23 || mm > 59) return null;
    return { h: hh, m: mm };
  }

  // 用幾個不同的門檻試讀，第一個讀得出「時:分」的就採用
  async function readCanvas(src, sx, sy, sw, sh) {
    const w = await getWorker();
    const texts = [];
    let img = null;
    for (const shift of [0, 0.12, -0.12, 0.25]) {
      img = preprocess(src, sx, sy, sw, sh, shift);
      const { data } = await w.recognize(img);
      texts.push(data.text.trim());
      const clock = parseClock(data.text);
      if (clock) return { clock, text: data.text.trim(), image: img };
    }
    return { clock: null, text: texts.join(' / '), image: img };
  }

  return { getWorker, readCanvas, parseClock, preprocess };
})();
