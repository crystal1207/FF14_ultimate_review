'use strict';
// 讀取畫面時鐘的精確校正。
//
// 找「跳分鐘的那一刻」不需要讀懂數字：先取兩組參考畫面
//   舊：確定是第 M 分的幾張畫面    新：確定是第 M+1 分的幾張畫面
// 每組逐像素取中位數，背景會被平均掉、只留下時鐘數字；再只看兩組差最多的像素（會變的那位數字）。
// 之後每張畫面只要比較「比較像舊的還是新的」，就能二分搜尋出跳分的影片秒數。
// 這比每張都做 OCR 穩定很多（實測 720p 的直播存檔 21 張全部判斷正確）。
// 第 M 分是幾點幾分：已有校正（例如依直播開始時間）時，挑預估在 :30 的位置，幾秒誤差不影響分鐘；
// 沒有任何校正時，才用 OCR 讀一次數字（讀不出來就請使用者輸入）。

window.ClockCal = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 時鐘區域 → 正規化灰階小圖 ----------
  // 用灰階並減去平均、除以標準差，背景變亮變暗都不影響比較。
  // 對比太低（黑畫面、還沒解碼完的畫面）回傳 null，呼叫端會重新取樣。
  const PW = 64;
  const PH = 24;
  function toPatch(src, sx, sy, sw, sh) {
    const c = document.createElement('canvas');
    c.width = PW;
    c.height = PH;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, sx, sy, sw, sh, 0, 0, PW, PH);
    const d = g.getImageData(0, 0, PW, PH).data;
    const a = new Float32Array(PW * PH);
    let mean = 0;
    for (let i = 0; i < a.length; i++) {
      a[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114;
      mean += a[i];
    }
    mean /= a.length;
    let ss = 0;
    for (let i = 0; i < a.length; i++) { a[i] -= mean; ss += a[i] * a[i]; }
    const std = Math.sqrt(ss / a.length);
    if (std < 12) return null;
    for (let i = 0; i < a.length; i++) a[i] /= std;
    return a;
  }
  // 多張畫面逐像素取中位數：背景會被平均掉，只留下不變的時鐘數字
  function median(list) {
    const n = list[0].length;
    const out = new Float32Array(n);
    const col = new Array(list.length);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < list.length; k++) col[k] = list[k][i];
      col.sort((x, y) => x - y);
      out[i] = col[col.length >> 1];
    }
    return out;
  }
  // 只用「舊、新參考差最多」的像素（也就是會變的那位數字）來判斷，框得鬆一點也沒關係
  function makeClassifier(oldRef, newRef) {
    const diff = Array.from(oldRef, (o, i) => Math.abs(o - newRef[i]));
    const cut = [...diff].sort((x, y) => y - x)[Math.floor(diff.length * 0.15)];
    const idx = [];
    diff.forEach((v, i) => { if (v >= cut) idx.push(i); });
    const dist = (p, r) => {
      let s = 0;
      for (const i of idx) { const e = p[i] - r[i]; s += e * e; }
      return s / idx.length;
    };
    return {
      separation: dist(oldRef, newRef),
      isOld: (p) => dist(p, oldRef) < dist(p, newRef),
    };
  }

  // ---------- 分享分頁畫面 ----------
  class TabCapture {
    constructor(target) {
      this.target = target; // 播放器外框元素
      this.stream = null;
      this.video = null;
      this.cropped = false;
      this.canvas = document.createElement('canvas');
    }

    async start() {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error('這個瀏覽器不支援分享分頁畫面，請用電腦版 Chrome 或 Edge。');
      }
      try {
        this.stream = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'browser', frameRate: 30 },
          audio: false,
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
        });
      } catch (e) {
        throw new Error('沒有取得分享畫面的同意（' + (e.message || e.name) + '）。');
      }
      const track = this.stream.getVideoTracks()[0];
      // Chrome 支援把分享畫面裁到指定元素，最準
      if (window.CropTarget && track.cropTo) {
        try {
          await track.cropTo(await CropTarget.fromElement(this.target));
          this.cropped = true;
        } catch { this.cropped = false; }
      }
      if (!this.cropped && track.getSettings().displaySurface && track.getSettings().displaySurface !== 'browser') {
        this.stop();
        throw new Error('請在分享視窗選擇「這個分頁」，不要選整個螢幕或視窗。');
      }
      this.video = document.createElement('video');
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = this.stream;
      // 放進頁面（幾乎看不見），避免瀏覽器把不在頁面上的影片暫停更新
      Object.assign(this.video.style, { position: 'fixed', right: '0', bottom: '0', width: '2px', height: '2px', opacity: '0.01', pointerEvents: 'none', zIndex: '-1' });
      document.body.appendChild(this.video);
      // 記錄收到幾張新畫面，用來判斷分享的畫面有沒有在更新
      this.frames = 0;
      const onFrame = () => { this.frames++; if (this.stream) this.video.requestVideoFrameCallback(onFrame); };
      if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(onFrame);
      await this.video.play();
      await sleep(300);
      this.debug = { cropped: this.cropped, settings: track.getSettings(), shots: [], full: null };
    }

    // box：相對於播放器的比例 {x, y, w, h}
    grab(box) {
      const v = this.video;
      const fw = v.videoWidth;
      const fh = v.videoHeight;
      let px, py, pw, ph;
      if (this.cropped) {
        px = 0; py = 0; pw = fw; ph = fh;
      } else {
        const r = this.target.getBoundingClientRect();
        const s = fw / window.innerWidth;
        px = r.left * s; py = r.top * s; pw = r.width * s; ph = r.height * s;
      }
      const sx = px + box.x * pw;
      const sy = py + box.y * ph;
      const sw = box.w * pw;
      const sh = box.h * ph;
      const patch = toPatch(v, sx, sy, sw, sh);
      this.record(v, [sx, sy, sw, sh], patch, [px, py, pw, ph]);
      return { patch, src: v, rect: [sx, sy, sw, sh], pixelHeight: sh };
    }

    // 留下截到的畫面，失敗時給使用者看（方便找出是框選位置還是畫面沒更新的問題）
    record(v, rect, patch, player) {
      const d = this.debug;
      if (!d) return;
      if (!d.full) {
        const c = document.createElement('canvas');
        const k = 640 / v.videoWidth;
        c.width = 640;
        c.height = Math.round(v.videoHeight * k);
        const g = c.getContext('2d');
        g.drawImage(v, 0, 0, c.width, c.height);
        g.strokeStyle = '#0f0';
        g.lineWidth = 2;
        g.strokeRect(player[0] * k, player[1] * k, player[2] * k, player[3] * k);
        g.strokeStyle = '#f0f';
        g.strokeRect(rect[0] * k - 2, rect[1] * k - 2, rect[2] * k + 4, rect[3] * k + 4);
        d.full = c;
        d.size = [v.videoWidth, v.videoHeight];
        d.rect = rect.map(Math.round);
      }
      if (d.shots.length >= 16) return;
      const c = document.createElement('canvas');
      const k = 48 / Math.max(1, rect[3]);
      c.width = Math.max(1, Math.round(rect[2] * k));
      c.height = 48;
      c.getContext('2d').drawImage(v, rect[0], rect[1], rect[2], rect[3], 0, 0, c.width, c.height);
      d.shots.push({ canvas: c, frames: this.frames, ok: Boolean(patch) });
    }

    stop() {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.video?.remove();
    }
  }

  // ---------- 搜尋跳分鐘的那一刻 ----------
  // io：{ seek(t), play(), pause(), setRate(r), time(), grab() → {patch}, log(msg) }
  // plan：{ oldTimes: 確定是舊分鐘的影片秒數們, newTimes: 確定是新分鐘的影片秒數們, lo, hi: 跳分一定在 (lo, hi] 之間 }
  // 跳到 t 並播放一下再取畫面（暫停時的畫面有時還沒解碼完）；畫面不清楚就往後一點重試
  // 不固定等待：等影片真的從新位置開始播放（時間走過 t 一點點）再取畫面，
  // 已經載好的位置大約 0.3 秒就能取到，網路慢需要緩衝時也不會取到跳轉前的舊畫面。
  async function sampleAt(io, t) {
    for (let k = 0; k < 3; k++) {
      const target = t + k * 0.3;
      io.seek(target);
      io.play();
      const t0 = performance.now();
      await sleep(200);
      for (;;) {
        const now = io.time();
        if (now >= target + 0.1 && now < target + 3) break;
        if (performance.now() - t0 > 4000) break;
        await sleep(30);
      }
      await sleep(100); // 分享畫面本身也有一點延遲
      const g = io.grab();
      if (g.patch) return { t: io.time(), patch: g.patch };
    }
    return null;
  }

  // 還沒有任何校正時，找出跳分大概在哪 10 秒內。
  // 已知影片 a 秒是某一分鐘（例如 23:59），那 a+60 秒一定是下一分鐘；中間每 10 秒取一張，
  // 每張比較像開頭還是結尾，找出最一致的分界。結果只是粗略範圍，之後 findFlip 會精確定位並互相驗證。
  async function coarseWindow(io, a) {
    io.setRate(1);
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      io.log(`尋找跳分的大概位置 ${i + 1}/7…`);
      const s = await sampleAt(io, a + i * 10 - 0.2);
      if (s) pts.push(s);
    }
    io.pause();
    if (pts.length < 5 || pts[0].t > a + 3 || pts[pts.length - 1].t < a + 57) {
      throw new Error('時鐘區域的畫面太暗或看不清楚，請確認框選位置和播放畫質（建議 1080p）。');
    }
    const first = pts[0].patch;
    const last = pts[pts.length - 1].patch;
    const cls = makeClassifier(first, last);
    if (cls.separation < 0.3) {
      throw new Error('時鐘區域在一分鐘前後看起來沒有變化，請按「重新框選時鐘」框住時間數字，或把畫質調到 1080p。');
    }
    const old = pts.map((p, i) => i === 0 || (i !== pts.length - 1 && cls.isOld(p.patch)));
    let best = null;
    for (let k = 1; k < pts.length; k++) {
      let err = 0;
      for (let i = 0; i < pts.length; i++) if (old[i] !== i < k) err++;
      if (!best || err < best.err) best = { k, err };
    }
    return { lo: pts[best.k - 1].t, hi: pts[best.k].t, errors: best.err };
  }

  // plan.oldPatches／plan.newPatches：之前已經取過、確定是舊／新分鐘的畫面（相鄰兩次跳分可以共用，省時間）
  async function findFlip(io, plan) {
    const sample = (t) => sampleAt(io, t);

    io.setRate(1);
    const oldList = plan.oldPatches ? [...plan.oldPatches] : [];
    const newList = plan.newPatches ? [...plan.newPatches] : [];
    const todo = [...(plan.oldPatches ? [] : plan.oldTimes.map((t) => [t, oldList])), ...(plan.newPatches ? [] : plan.newTimes.map((t) => [t, newList]))];
    for (const [i, [t, list]] of todo.entries()) {
      io.log(`取得參考畫面 ${i + 1}/${todo.length}…`);
      const s = await sample(t);
      if (s) list.push(s.patch);
    }
    if (oldList.length < 3 || newList.length < 3) {
      throw new Error('時鐘區域的畫面太暗或看不清楚，請確認框選位置和播放畫質（建議 1080p）。');
    }
    const cls = makeClassifier(median(oldList), median(newList));
    if (cls.separation < 0.3) {
      throw new Error('時鐘區域在一分鐘前後看起來沒有變化，請按「重新框選時鐘」框住時間數字，或把畫質調到 1080p。');
    }

    // 粗找：一邊播放一邊二分，縮到 2 秒內
    let lo = plan.lo;
    let hi = plan.hi;
    for (let i = 0; i < 10 && hi - lo > 2; i++) {
      io.log(`粗略搜尋中（範圍剩 ${Math.ceil(hi - lo)} 秒）…`);
      const s = await sample((lo + hi) / 2 - 0.1);
      if (!s || s.t <= lo || s.t >= hi) continue;
      if (cls.isOld(s.patch)) lo = s.t; else hi = s.t;
    }

    // 細找：從粗找區間前 1 秒以 0.5 倍速播放到區間後 1.2 秒，把每張畫面都分類，
    // 最後找「最一致」的切點（切點前都是舊、切點後都是新），個別誤判的畫面不會影響結果。
    io.log('精確定位中…');
    const start = Math.max(0, lo - 1);
    const end = hi + 1.2;
    io.pause();
    io.setRate(0.5);
    io.seek(start);
    await sleep(400);
    io.play();
    // 等播放真的從新位置往前走（剛跳轉時畫面可能還是舊位置的）
    const waitStart = performance.now();
    while (io.time() < start + 0.15 && performance.now() - waitStart < 6000) await sleep(30);
    await sleep(250);
    const pts = [];
    const deadline = performance.now() + 40_000;
    while (performance.now() < deadline) {
      const t = io.time();
      const g = io.grab();
      if (g.patch && t >= start + 0.15) pts.push({ t, old: cls.isOld(g.patch) });
      if (t > end) break;
      await sleep(30);
    }
    io.pause();
    io.setRate(1);
    pts.sort((a, b) => a.t - b.t);
    const refs = { oldRefs: oldList, newRefs: newList };
    const fallback = { flip: (lo + hi) / 2, precision: (hi - lo) / 2, ...refs };
    if (pts.length < 10) return fallback;
    // 切在第 k 張之前：錯誤數 ＝ 切點前的「新」＋ 切點後的「舊」
    const newBefore = [0];
    for (const p of pts) newBefore.push(newBefore[newBefore.length - 1] + (p.old ? 0 : 1));
    const totalOld = pts.filter((p) => p.old).length;
    let best = { k: 0, err: Infinity };
    let oldBefore = 0;
    for (let k = 0; k <= pts.length; k++) {
      if (k > 0 && pts[k - 1].old) oldBefore++;
      const err = newBefore[k] + (totalOld - oldBefore);
      if (err < best.err) best = { k, err };
    }
    const { k, err } = best;
    if (k === 0 || k === pts.length || err > pts.length * 0.2) return fallback;
    return {
      flip: (pts[k - 1].t + pts[k].t) / 2,
      precision: Math.max(0.03, (pts[k].t - pts[k - 1].t) / 2),
      outliers: err,
      samples: pts.length,
      ...refs,
    };
  }

  // ---------- 框選時鐘 ----------
  function pickBox(container, initial) {
    return new Promise((resolve) => {
      const layer = document.createElement('div');
      layer.className = 'box-picker';
      layer.innerHTML = '<div class="box-hint">拖曳框住右上角時鐘的「數字」（例如 21:46，不要包含「本」圖示）。按 Esc 取消。</div><div class="box-rect"></div>';
      container.appendChild(layer);
      const rectEl = layer.querySelector('.box-rect');
      const show = (b) => {
        if (!b) { rectEl.style.display = 'none'; return; }
        Object.assign(rectEl.style, { display: 'block', left: b.x * 100 + '%', top: b.y * 100 + '%', width: b.w * 100 + '%', height: b.h * 100 + '%' });
      };
      show(initial);
      let start = null;
      const rel = (e) => {
        const r = layer.getBoundingClientRect();
        return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
      };
      const done = (b) => {
        layer.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(b);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      document.addEventListener('keydown', onKey, true);
      layer.addEventListener('pointerdown', (e) => {
        start = rel(e);
        layer.setPointerCapture(e.pointerId);
      });
      layer.addEventListener('pointermove', (e) => {
        if (!start) return;
        const p = rel(e);
        show({ x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
      });
      layer.addEventListener('pointerup', (e) => {
        if (!start) return;
        const p = rel(e);
        const b = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
        start = null;
        if (b.w < 0.01 || b.h < 0.01) return; // 太小，當作誤點
        done(b);
      });
    });
  }

  return { TabCapture, findFlip, coarseWindow, pickBox, toPatch, median, makeClassifier };
})();
