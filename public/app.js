// 絕本復盤器：YouTube 第一視角影片 × ACT／IINACT 戰鬥紀錄同步。純前端，log 只在使用者的瀏覽器裡解析。
import { lookupActions, lookupItems, itemFromAbility, isMountAbility } from './lib/xivapi.js?v=dev';
import { saveHandle, loadHandle, ensurePermission, listLogs } from './lib/handles.js?v=dev';
import { analyzeGcd } from './lib/gcd.js?v=dev';

const $ = (id) => document.getElementById(id);
const FRAME = 1 / 30;

const state = {
  logs: [], // { name, size, mtime, handle?（資料夾裡的檔案）, file?（直接選的檔案） }
  dir: null, // 選過的 log 資料夾
  report: null,
  videoId: null,
  videoLen: 0, // 影片長度（秒），播放器載入後取得
  cal: null, // { anchorVideo: 影片秒數, anchorWall: 本機時間毫秒, base }
  rangeOnly: true,
  day: null, // 沒有校正時用日期篩選場次
  zone: null,
  fightId: null,
  fight: null,
  data: null,
  job: null, // 使用者選的職業
  playerId: null,
  notes: {},
  events: [],
  px: Number(lsGet('zoom', 18)),
  lead: Number(lsGet('lead', 3)),
  follow: true,
  autoSwitch: true,
  loadingFight: 0,
};

let player = null;
let ytReady = false;
let pendingVideo = null;

// ---------- 小工具 ----------
function lsGet(k, d) {
  try { const v = localStorage.getItem('ur.' + k); return v == null ? d : v; } catch { return d; }
}
function lsSet(k, v) {
  try { localStorage.setItem('ur.' + k, v); } catch { /* 無痕模式等情況忽略 */ }
}
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
function fmtDur(sec, withTenths = false) {
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const str = withTenths ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${pad(s)}`;
  return (neg ? '-' : '') + str;
}
function fmtVideo(sec) {
  if (!isFinite(sec)) return '--:--';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' + pad(m) : m) + ':' + s.toFixed(1).padStart(4, '0');
}
function fmtClock(ms, tenths = false) {
  const d = new Date(ms);
  const base = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return tenths ? base + '.' + Math.floor(d.getMilliseconds() / 100) : base;
}
function fmtSize(b) {
  return b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(0) + ' MB' : Math.ceil(b / 1e3) + ' KB';
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function banner(msg, kind = 'error') {
  const b = $('banner');
  if (!msg) { b.hidden = true; return; }
  b.textContent = msg;
  b.className = 'banner' + (kind === 'info' ? ' info' : '');
  b.hidden = false;
}
// 筆記、校正值存在瀏覽器（localStorage）
const STORE_PREFIX = 'ur.s.';
function storeGet(key) {
  try { const v = localStorage.getItem(STORE_PREFIX + key); return v == null ? null : JSON.parse(v); } catch { return null; }
}
function storePrefix(prefix) {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(STORE_PREFIX + prefix)) out[k.slice(STORE_PREFIX.length)] = JSON.parse(localStorage.getItem(k));
    }
  } catch { /* 無痕模式等情況 */ }
  return out;
}
function saveStore(key, value) {
  try {
    if (value == null) localStorage.removeItem(STORE_PREFIX + key);
    else localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    banner('儲存失敗（瀏覽器空間不足或禁止儲存）：' + e.message);
    return false;
  }
}
const jobName = (job) => (JOBS[job] || [job || '未知'])[0];
const jobRole = (job) => (JOBS[job] || [])[1] || '';

function parseVideoId(s) {
  s = s.trim();
  const m =
    s.match(/youtube\.com\/(?:live|embed|shorts)\/([\w-]{11})/) ||
    s.match(/[?&]v=([\w-]{11})/) ||
    s.match(/youtu\.be\/([\w-]{11})/) ||
    s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

// ---------- 時間換算 ----------
// log 的時間和畫面右上角的時鐘是同一個電腦時鐘；校正點把它對到影片秒數。
const wallToVideo = (ms) => state.cal.anchorVideo + (ms - state.cal.anchorWall) / 1000;
const videoToWall = (v) => state.cal.anchorWall + (v - state.cal.anchorVideo) * 1000;
const fightWall = (f, t) => state.report.startTime + f.startTime + t * 1000;
function videoToFightT(v, f = state.fight) {
  if (!state.cal || !f) return null;
  return (videoToWall(v) - state.report.startTime - f.startTime) / 1000;
}

// 影片涵蓋的本機時間範圍（毫秒）；不知道時回傳 null
function videoRange() {
  if (state.cal && state.videoLen) return [videoToWall(0), videoToWall(state.videoLen)];
  return null;
}

// 「打本日」：凌晨 6 點前算前一天（深夜直播跨過午夜時不會被切成兩天）
const DAY_SHIFT = 6 * 3600_000;
function dayKey(ms) {
  const d = new Date(ms - DAY_SHIFT);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const dayLabel = (key) => { const [, m, d] = key.split('-'); return `${Number(m)}/${Number(d)}`; };
const fightDay = (f) => dayKey(state.report.startTime + f.startTime);

// 「21:47」或「21:47:03」→ 最接近參考時段的那一天的本機時間。
// 參考時段：已校正就用影片時段；否則用選取的這一把（或列表中的場次）的時間
// atVideo：畫面上顯示這個時間時的影片秒數。還沒校正時，畫面時鐘只有時間沒有日期，
// 所以把前後幾天都試一次，選「影片時段內打的場次最多」的那一天（連續幾天同一時段打本也能分辨）。
function resolveClock(text, atVideo = null) {
  const m = text.trim().match(/^(\d{1,2})[:：](\d{2})(?:[:：](\d{2}(?:\.\d+)?))?$/);
  if (!m) return null;
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  if (h > 23 || mi > 59 || s >= 60) return null;
  const vr = videoRange();
  const [lo, hi] = vr || refRange();
  const base = new Date(lo);
  const byCount = !vr && atVideo != null && state.videoLen > 0;
  let best = null;
  for (const off of [-2, -1, 0, 1, 2]) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + off, h, mi, 0, 0).getTime() + s * 1000;
    const dist = d < lo ? lo - d : d > hi ? d - hi : 0;
    const count = byCount ? fightsBetween(d - atVideo * 1000, d + (state.videoLen - atVideo) * 1000) : 0;
    if (!best || count > best.count || (count === best.count && dist < best.dist)) best = { ms: d, dist, count };
  }
  return best.ms;
}
// 這段本機時間內有幾把（有重疊就算）
function fightsBetween(from, to) {
  const b = state.report.startTime;
  return state.report.fights.filter((f) => b + f.startTime < to && b + f.endTime > from).length;
}
function refRange() {
  const base = state.report.startTime;
  if (state.fight) return [base + state.fight.startTime, base + state.fight.endTime];
  const list = zoneFights();
  if (list.length) return [base + list[0].startTime, base + list[list.length - 1].endTime];
  return [state.report.startTime, state.report.endTime];
}

// ---------- YouTube ----------
window.onYouTubeIframeAPIReady = () => {
  ytReady = true;
  if (pendingVideo) createPlayer(pendingVideo);
};
if (window.YT?.Player) ytReady = true; // 這個檔案是 module，可能比 YouTube API 晚執行
function createPlayer(videoId, { clean = false, start = 0 } = {}) {
  if (!ytReady) { pendingVideo = videoId; return Promise.resolve(); }
  $('videoEmpty').hidden = true;
  if (player && !clean && !player.__clean) { player.cueVideoById(videoId); return Promise.resolve(); }
  if (player) { player.destroy(); player = null; }
  // clean：沒有控制列與按鈕的播放器，讀取畫面時鐘時用，避免 YouTube 的按鈕蓋住右上角時鐘
  const vars = clean
    ? { rel: 0, playsinline: 1, origin: location.origin, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, start: Math.floor(start) }
    : { rel: 0, playsinline: 1, origin: location.origin, modestbranding: 1, start: Math.floor(start) };
  return new Promise((resolve) => {
    const p = new YT.Player('player', {
      videoId,
      playerVars: vars,
      events: {
        onReady: () => { updateVideoLen(); resolve(); },
        onStateChange: (e) => { $('playBtn').textContent = e.data === YT.PlayerState.PLAYING ? '❚❚' : '▶︎'; },
        onError: (e) => banner(`YouTube 播放器錯誤（代碼 ${e.data}）。私人影片無法嵌入，請把影片設成「不公開」。`),
      },
    });
    p.__clean = clean;
    player = p;
  });
}
// 影片長度要等播放器載入後才知道；知道後重新依影片時段篩選場次
function updateVideoLen() {
  const len = playerReady() ? player.getDuration() : 0;
  if (!(len > 0) || Math.abs(len - state.videoLen) < 1) return;
  state.videoLen = len;
  if (state.report && state.cal) { refreshFilters(); fillCalDate(); }
}
const playerReady = () => player && typeof player.getCurrentTime === 'function';
const isPlaying = () => playerReady() && player.getPlayerState?.() === YT.PlayerState.PLAYING;
function curVideo() { return playerReady() ? player.getCurrentTime() : NaN; }
function seekVideo(sec) {
  if (playerReady()) player.seekTo(Math.max(0, sec), true);
}
function seekFightT(t) {
  if (!state.cal) { needCal(); return; }
  seekVideo(wallToVideo(fightWall(state.fight, t)));
}
function needCal() {
  banner('還沒有校正：先在左邊點一把這部影片裡打的場次，再到「時間校正」按「讀取畫面時鐘自動校正」（或用方法一、二）。', 'info');
  $('calPanel').open = true;
}

// ---------- log 清單 ----------
// Chrome／Edge 可以選「資料夾」，之後每次打開都會列出裡面的 Network_*.log；其他瀏覽器一次選一個檔案
const canPickDir = 'showDirectoryPicker' in window;
async function refreshLogList({ ask = false } = {}) {
  const files = state.logs.filter((l) => l.file); // 直接選的檔案保留
  let fromDir = [];
  if (state.dir && (await ensurePermission(state.dir, ask))) {
    try { fromDir = await listLogs(state.dir); } catch { fromDir = []; }
  }
  state.logs = [...files, ...fromDir];
  renderLogList();
}
function renderLogList() {
  const sel = $('logSel');
  const last = lsGet('logName', '');
  const opts = state.logs.map((l, i) => {
    const d = new Date(l.mtime);
    const when = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `<option value="${i}">${esc(l.name)}（${when} · ${fmtSize(l.size)}）</option>`;
  });
  if (!opts.length) {
    const hint = state.dir ? `按「選擇資料夾…」重新開啟 ${state.dir.name}` : canPickDir ? '請按「選擇資料夾…」或「選擇檔案…」' : '請按「選擇檔案…」';
    opts.push(`<option value="">${esc(hint)}</option>`);
  }
  sel.innerHTML = opts.join('');
  const idx = state.logs.findIndex((l) => l.name === last);
  if (state.logs[0]?.file) sel.value = '0';
  else if (idx >= 0) sel.value = String(idx);
}
async function pickDir() {
  try {
    // 上次選的資料夾還在的話，重新要求權限就好
    if (state.dir && !state.logs.some((l) => l.handle) && (await ensurePermission(state.dir, true))) {
      await refreshLogList();
      if (state.logs.some((l) => l.handle)) return;
    }
    const dir = await window.showDirectoryPicker({ id: 'actlogs', mode: 'read' });
    state.dir = dir;
    await saveHandle('logDir', dir);
    await refreshLogList();
    if (!state.logs.some((l) => l.handle)) banner(`「${dir.name}」裡沒有 Network_*.log。ACT 的 log 通常在 %APPDATA%\\Advanced Combat Tracker\\FFXIVLogs。`, 'info');
    else banner(null);
  } catch (e) {
    if (e.name !== 'AbortError') banner('無法開啟資料夾：' + e.message);
  }
}

// ---------- 背景解析 ----------
let worker = null;
let rpcSeq = 0;
const rpcWait = new Map();
let onParseProgress = null;
function rpc(msg) {
  if (!worker) {
    worker = new Worker('parser-worker.js?v=dev', { type: 'module' });
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'progress') { onParseProgress?.(d.ratio); return; }
      const w = rpcWait.get(d.id);
      if (!w) return;
      rpcWait.delete(d.id);
      if (d.error) w.reject(new Error(d.error));
      else w.resolve(d.result);
    };
    worker.onerror = (e) => {
      for (const w of rpcWait.values()) w.reject(new Error(e.message || '解析程式發生錯誤'));
      rpcWait.clear();
    };
  }
  const id = ++rpcSeq;
  return new Promise((resolve, reject) => {
    rpcWait.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}

// ---------- 載入 ----------
async function loadAll() {
  const entry = state.logs[Number($('logSel').value)];
  const videoId = parseVideoId($('videoInput').value);
  if (!entry || $('logSel').value === '') { banner('請先選擇當天的 log（ACT／IINACT 的 Network_*.log）。'); return; }
  banner(null);
  lsSet('video', $('videoInput').value.trim());
  lsSet('logName', entry.name);

  const list = $('pullList');
  list.innerHTML = '<p class="muted pad">讀取 log 中…</p>';
  const t0 = performance.now();
  try {
    let file = entry.file;
    if (entry.handle) {
      if (!(await ensurePermission(state.dir, true))) throw new Error('沒有讀取資料夾的權限，請重新按「選擇資料夾…」。');
      file = await entry.handle.getFile(); // 每次重新取得，ACT 還在記錄時能讀到最新內容
    }
    onParseProgress = (ratio) => {
      list.innerHTML = `<p class="muted pad">解析 log 中… ${Math.round(ratio * 100)}%<br><span class="small">log 只在你的瀏覽器裡解析，不會上傳。</span></p>`;
    };
    state.report = await rpc({ type: 'parse', file });
    console.log(`[log] ${state.report.lines} 行、${state.report.fights.length} 把，${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
  } catch (e) {
    list.innerHTML = '';
    banner('解析失敗：' + e.message);
    return;
  } finally {
    onParseProgress = null;
  }
  state.notes = storePrefix('note:');
  state.fight = null;
  state.fightId = null;

  if (videoId) {
    if (videoId !== state.videoId) {
      state.videoId = videoId;
      state.videoLen = 0;
      createPlayer(videoId);
    }
    state.cal = storeGet('cal:' + videoId);
    updateVideoLen();
  } else {
    state.videoId = null;
    state.cal = null;
    banner('沒有影片網址：可以先看時間軸，但不能跳到影片。', 'info');
  }
  state.day = null;
  updateCalStatus();
  refreshFilters();
  if (videoId && !state.cal) {
    banner('這部影片還沒校正：先在左上選日期、在左邊點一把這部影片裡打的場次，再打開「時間校正」按「讀取畫面時鐘自動校正」。', 'info');
    $('calPanel').open = true;
  }
}

// 重新整理日期／副本篩選與場次列表
function refreshFilters() {
  fillDays();
  fillZones();
  fillJobs();
  renderPulls();
  const list = zoneFights();
  if (state.fight && list.includes(state.fight)) { markActivePull(); return; }
  if (list.length) selectFight(list[0].id, { seek: false });
  else {
    state.fight = null;
    state.fightId = null;
    state.data = null;
    $('tlCanvas').innerHTML = '<div class="tl-empty">沒有可顯示的戰鬥。</div>';
  }
}

function calOffset() {
  const c = state.cal;
  if (!c) return 0;
  const b = c.base || c;
  return Math.round((c.anchorVideo - b.anchorVideo - (c.anchorWall - b.anchorWall) / 1000) * 100) / 100;
}
function updateOffsetUI() {
  const off = calOffset();
  const inp = $('offsetInput');
  if (document.activeElement !== inp) inp.value = off.toFixed(1);
  inp.disabled = !state.cal;
  $('offsetReset').disabled = !state.cal || off === 0;
  inp.closest('.offset').classList.toggle('moved', off !== 0);
}
// 手動調整時間軸：把標記往影片後面（正）或前面（負）移，以自動校正結果為基準
function setOffset(sec) {
  if (!state.cal) { needCal(); return; }
  const c = state.cal;
  const b = c.base || { anchorVideo: c.anchorVideo, anchorWall: c.anchorWall };
  sec = Math.round(sec * 100) / 100;
  setCal(b.anchorVideo + sec, b.anchorWall, b);
}
// 「影片日期」選單：時鐘只有時間沒有日期，配錯天時可以整段往前／往後移一天
const DAY_MS = 86_400_000;
function fillCalDate() {
  const row = $('calDateRow');
  const hint = $('rangeHint');
  if (!state.cal || !state.report) { row.hidden = true; hint.hidden = true; return; }
  row.hidden = false;
  // 左邊列表上方的提示：目前對到哪一天，配錯天可以點過去改
  const s0 = new Date(videoToWall(0));
  hint.hidden = false;
  hint.innerHTML = `影片日期：<b>${s0.getMonth() + 1}/${s0.getDate()} ${fmtClock(s0.getTime()).slice(0, 5)} 開始</b><br>場次對不上？<a href="#" id="fixDateLink">點這裡手動改日期</a>`;
  const len = state.videoLen || 0;
  const opts = [];
  for (let k = -2; k <= 2; k++) {
    const start = videoToWall(0) + k * DAY_MS;
    const d = new Date(start);
    const n = len ? fightsBetween(start, start + len * 1000) : null;
    opts.push(`<option value="${k}">${d.getMonth() + 1}/${d.getDate()} ${fmtClock(start).slice(0, 5)} 開始${n != null ? `（影片內 ${n} 把）` : ''}</option>`);
  }
  $('calDateSel').innerHTML = opts.join('');
  $('calDateSel').value = '0';
}
function shiftCalDays(k) {
  const c = state.cal;
  if (!c || !k) return;
  const b = c.base || c;
  state.rangeOnly = true;
  $('rangeOnly').checked = true;
  setCal(c.anchorVideo, c.anchorWall + k * DAY_MS, { anchorVideo: b.anchorVideo, anchorWall: b.anchorWall + k * DAY_MS });
}
function updateCalStatus() {
  updateOffsetUI();
  fillCalDate();
  const el = $('calStatus');
  if (state.cal) {
    const how = '已校正';
    const off = calOffset();
    const adj = off ? `（手動偏移 ${off > 0 ? '+' : ''}${off.toFixed(1)} 秒）` : '';
    const d0 = new Date(videoToWall(0));
    el.textContent = `${how}：影片 0:00 ＝ ${d0.getMonth() + 1}/${d0.getDate()} ${fmtClock(videoToWall(0), true)}${adj}`;
    el.classList.add('ok');
  } else {
    el.textContent = '尚未校正';
    el.classList.remove('ok');
  }
}
// base：自動校正（直播時間／讀取時鐘／方法一、二）的結果；手動微調只改 anchorVideo，偏移量＝和 base 的差
async function setCal(anchorVideo, anchorWall, base = null) {
  if (!base) {
    // 新的校正：列表直接切到影片時段內的場次
    state.rangeOnly = true;
    $('rangeOnly').checked = true;
  }
  state.cal = { anchorVideo, anchorWall, base: base || { anchorVideo, anchorWall } };
  updateCalStatus();
  banner(null);
  if (state.videoId) saveStore('cal:' + state.videoId, state.cal);
  renderPlayhead(true);
  refreshFilters();
}

// ---------- 我的職業（第一視角） ----------
function fillJobs() {
  const sel = $('jobSel');
  const groups = [['tank', '坦克'], ['healer', '治療'], ['melee', '近戰'], ['ranged', '遠程物理'], ['caster', '魔法']];
  sel.innerHTML = groups
    .map(([role, label]) => {
      const opts = Object.entries(JOBS)
        .filter(([, v]) => v[1] === role)
        .map(([k, v]) => `<option value="${k}">${v[0]}</option>`)
        .join('');
      return `<optgroup label="${label}">${opts}</optgroup>`;
    })
    .join('');
  // 預設：這部影片上次選的職業 → log 記錄者（ACT 的主角，通常就是第一視角）在這段時間最常玩的職業
  const meId = state.report.me?.id;
  const count = {};
  for (const f of zoneFights()) {
    const p = f.players.find((x) => x.id === meId);
    if (p?.job) count[p.job] = (count[p.job] || 0) + 1;
  }
  const meJob = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0];
  state.job = (state.videoId && lsGet('job:' + state.videoId, '')) || meJob || lsGet('job', '') || 'Paladin';
  sel.value = state.job;
  fillGcdInput();
}

// 依選的職業找出這一把裡的「我」；同職業有兩個人時優先選 log 記錄者
function resolveMe(f) {
  const same = f.players.filter((p) => p.job === state.job);
  if (!same.length) return null;
  return same.find((p) => p.id === state.report.me?.id) || same[0];
}

// ---------- 場次篩選與列表 ----------
// 先依影片時段篩選（多天的 log 只留影片那段時間），再依副本篩選
// 已校正：依影片時段篩選；還沒校正（或取消勾選）：依日期篩選
function rangeFights() {
  const r = state.rangeOnly ? videoRange() : null;
  if (r) {
    const base = state.report.startTime;
    return state.report.fights.filter((f) => base + f.startTime < r[1] && base + f.endTime > r[0]);
  }
  if (state.day && state.day !== '__all') return state.report.fights.filter((f) => fightDay(f) === state.day);
  return state.report.fights;
}
function fillDays() {
  const sel = $('daySel');
  const useRange = state.rangeOnly && videoRange();
  const counts = new Map();
  for (const f of state.report.fights) { const k = fightDay(f); counts.set(k, (counts.get(k) || 0) + 1); }
  const days = [...counts.keys()].sort().reverse();
  if (useRange || days.length <= 1) { sel.innerHTML = ''; state.day = null; return; }
  sel.innerHTML = days.map((k) => `<option value="${k}">${dayLabel(k)}（${counts.get(k)} 把）</option>`).join('') + '<option value="__all">全部日期</option>';
  // 預設：選取中那一把的日期 → 最近一天
  if (!state.day || (state.day !== '__all' && !counts.has(state.day))) state.day = state.fight ? fightDay(state.fight) : days[0];
  sel.value = state.day;
}
function fillZones() {
  const counts = new Map();
  for (const f of rangeFights()) counts.set(f.name, (counts.get(f.name) || 0) + 1);
  const zones = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const sel = $('zoneSel');
  const prev = state.zone;
  if (zones.length <= 1) { sel.innerHTML = ''; state.zone = zones[0]?.[0] ?? null; return; }
  sel.innerHTML = zones.map(([z, n]) => `<option value="${esc(z)}">${esc(z)}（${n} 把）</option>`).join('') + '<option value="__all">全部副本</option>';
  state.zone = prev && (prev === '__all' || counts.has(prev)) ? prev : zones[0][0];
  sel.value = state.zone;
}
const zoneFights = () => rangeFights().filter((f) => !state.zone || state.zone === '__all' || f.name === state.zone);
const noteKey = (f) => `note:${state.report.startTime + f.startTime}`;

function fightLabel(f) {
  if (f.kill) return { text: '擊殺', cls: 'kill' };
  if (f.boss) return { text: `${f.boss.name} ${f.boss.hp != null ? f.boss.hp.toFixed(1) + '%' : ''}`, cls: '' };
  return { text: '滅團', cls: '' };
}
function renderPulls() {
  const list = $('pullList');
  const fights = zoneFights();
  if (!fights.length) {
    const r = state.rangeOnly ? videoRange() : null;
    list.innerHTML = r
      ? `<p class="muted pad">影片時段（${dayLabel(dayKey(r[0]))} ${fmtClock(r[0]).slice(0, 5)}～${fmtClock(r[1]).slice(0, 5)}）內沒有戰鬥。請確認 log 有包含影片那天，或取消勾選「只看影片時段內的場次」。</p>`
      : '<p class="muted pad">沒有戰鬥紀錄。</p>';
    return;
  }
  let html = '';
  let lastGroup = null;
  fights.forEach((f, i) => {
    const day = dayLabel(fightDay(f)); // 和日期選單一樣用「打本日」：凌晨 6 點前算前一天
    const group = `${f.name}｜${day}`;
    if (group !== lastGroup) { html += `<div class="pull-group">${esc(f.name)} · ${day}</div>`; lastGroup = group; }
    const lab = fightLabel(f);
    const dur = (f.endTime - f.startTime) / 1000;
    const note = state.notes[noteKey(f)];
    html += `<button class="pull" data-fight="${f.id}" title="${esc(lab.text)}">
      <span class="pull-no">#${i + 1}</span>
      <span class="pull-res ${lab.cls}">${esc(lab.text)}</span>
      <span>${fmtDur(dur)}</span>
      <span class="pull-meta">${fmtClock(state.report.startTime + f.startTime)} 開打${f.deaths ? ` · 死亡 ${f.deaths}` : ''}${note ? ' · <span class="pull-note" title="' + esc(note) + '">有筆記</span>' : ''}</span>
    </button>`;
  });
  list.innerHTML = html;
  markActivePull();
  if (!$('funPanel').hidden) renderFun();
}
function markActivePull() {
  document.querySelectorAll('.pull').forEach((b) => b.classList.toggle('active', Number(b.dataset.fight) === state.fightId));
  document.querySelector('.pull.active')?.scrollIntoView({ block: 'nearest' });
}

// ---------- 選取一把 ----------
async function selectFight(id, { seek = true } = {}) {
  const f = state.report.fights.find((x) => x.id === id);
  if (!f) return;
  state.fightId = id;
  state.fight = f;
  markActivePull();
  loadNote();
  if (seek) {
    if (state.cal) seekVideo(wallToVideo(fightWall(f, 0)) - Math.max(state.lead, 3));
    else needCal();
  }
  await loadFightData();
}

async function loadFightData() {
  const token = ++state.loadingFight;
  const me = resolveMe(state.fight);
  state.playerId = me?.id ?? null;
  $('jobWho').textContent = me
    ? `＝ ${me.name}`
    : `這一把隊伍裡沒有${jobName(state.job)}（隊伍：${state.fight.players.map((p) => jobName(p.job)).join('、')}）`;
  $('tlCanvas').innerHTML = '<div class="tl-empty">讀取這一把的事件中…</div>';
  try {
    const data = await fightData(state.fightId, state.playerId || '');
    if (token !== state.loadingFight) return; // 已經切到別把
    state.data = data;
    renderTimeline();
  } catch (e) {
    if (token !== state.loadingFight) return;
    state.data = null;
    $('tlCanvas').innerHTML = `<div class="tl-empty">讀取失敗：${esc(e.message)}</div>`;
  }
}

// 從背景解析程式拿這一把的事件，再用 XIVAPI 補上技能分類與圖示
async function fightData(fightId, playerId) {
  const raw = await rpc({ type: 'fight', fightId, playerId });
  // 道具（爆發藥等）和技能分開查；坐騎召喚直接略過
  const mine = raw.mine.filter((c) => !isMountAbility(c.id));
  const itemOf = new Map(mine.map((c) => [c, itemFromAbility(c.id)]).filter(([, it]) => it));
  const items = await lookupItems([...itemOf.values()].map((it) => it.item));
  const info = await lookupActions([...mine, ...raw.boss].filter((c) => !itemOf.has(c)).map((c) => c.id));
  const decorate = (c) => {
    const it = itemOf.get(c);
    if (it) {
      const d = items[it.item];
      // 只顯示藥品（爆發藥等）；食物、寵物召喚等標成 hidden
      const potion = /gemdraught|tincture|draught|elixir/i.test(d?.name || '');
      return {
        ...c,
        name: potion ? '爆發藥' : d?.name || `道具 #${it.item}`,
        detail: d?.name ? `${d.name}${it.hq ? ' HQ' : ''}` : '',
        kind: d?.medicine ? 'item' : 'hidden',
        icon: d?.icon ?? null,
        gcd: false,
        recast: 0,
      };
    }
    const a = info[c.id];
    return {
      ...c,
      name: c.name || a?.name || `#${c.id}`,
      kind: c.pet ? 'pet' : a?.kind ?? 'other',
      icon: a?.icon ?? null,
      gcd: Boolean(a?.gcd),
      recast: a?.recast ?? 0,
    };
  };
  const casts = mine.map(decorate).filter((c) => c.kind !== 'auto' && c.kind !== 'hidden');
  return {
    fightId,
    playerId,
    duration: raw.duration,
    preStart: Math.min(0, ...casts.map((c) => c.castStart ?? c.t)),
    phases: raw.phases,
    casts,
    boss: raw.boss.map(decorate),
    deaths: raw.deaths,
  };
}

// ---------- 死法統計（趣味） ----------
// 只頒準確度高的獎項：死最多、最常第一個倒、撞電網、滿血被一招秒殺、帶著易傷還硬吃、死亡宣告時間到、一招團滅
const AWARDS = [
  { key: 'most', icon: '⚰️', title: '地板常客', desc: '死最多次' },
  { key: 'first', icon: '🚩', title: '開路先鋒', desc: '最常是該把第一個倒下的人' },
  { key: 'wall', icon: '⚡', title: '電網之友', desc: '走出（或被擊退出）場地邊界，撞到電網', list: true },
  { key: 'oneshot', icon: '🔪', title: '一刀入魂', desc: '滿血（90% 以上）被一招直接打死', list: true },
  { key: 'vuln', icon: '🎯', title: '易傷收藏家', desc: '身上帶著受傷加重（易傷）還硬吃，被打死', list: true },
  { key: 'doom', icon: '💀', title: '死神的約定', desc: '死亡宣告時間到', list: true },
  { key: 'wipe', icon: '🌊', title: '一招團滅', desc: '同一招在幾秒內帶走 6 人以上', list: true, team: true },
];
function killText(d) {
  if (d.dot) return '被持續傷害（DoT）殺死';
  if (!d.ability) return '死因不明';
  return d.killer ? `被 ${d.killer} 的「${d.ability}」殺死` : `被「${d.ability}」殺死`;
}
let funToken = 0;
async function renderFun() {
  const body = $('funBody');
  const fights = state.report ? zoneFights() : [];
  if (!fights.length) { $('funScope').textContent = ''; body.innerHTML = '<p class="muted">左邊的列表沒有場次。</p>'; return; }
  const token = ++funToken;
  const byFight = await rpc({ type: 'deaths', fightIds: fights.map((f) => f.id) });
  if (token !== funToken) return;

  const people = new Map(); // 名字 -> { name, job, me, count: {most, first, ...} }
  const items = { wall: [], oneshot: [], vuln: [], doom: [], wipe: [] };
  const others = new Map(); // 名字 -> [死亡]
  let total = 0;
  const person = (f, d) => {
    const p = f.players.find((x) => x.id === d.target);
    const name = p ? p.name : d.name;
    let e = people.get(name);
    if (!e) people.set(name, (e = { name, job: p?.job, me: false, count: {} }));
    if (resolveMe(f)?.id === d.target) e.me = true;
    return e;
  };
  const bump = (e, k) => { e.count[k] = (e.count[k] || 0) + 1; };
  fights.forEach((f, idx) => {
    const list = byFight[f.id] || [];
    // 一招團滅：同一招 4 秒內 6 人以上
    const wipeSet = new Set();
    list.forEach((d, i) => {
      if (!d.ability || wipeSet.has(i)) return;
      const grp = list.map((x, j) => j).filter((j) => list[j].ability === d.ability && Math.abs(list[j].t - d.t) <= 4);
      if (grp.length >= 6) {
        grp.forEach((j) => wipeSet.add(j));
        items.wipe.push({ fightId: f.id, no: idx + 1, t: d.t, text: `被 ${d.killer || 'Boss'} 的「${d.ability}」帶走 ${grp.length} 人` });
      }
    });
    list.forEach((d, i) => {
      total++;
      const e = person(f, d);
      bump(e, 'most');
      if (i === 0) bump(e, 'first');
      const occ = { fightId: f.id, no: idx + 1, t: d.t, who: e.name, me: e.me, text: killText(d) };
      let awarded = wipeSet.has(i);
      if (!d.dot && d.hpPct != null && d.hpPct >= 0.9 && d.byAgo != null && d.byAgo <= 4) { bump(e, 'oneshot'); items.oneshot.push(occ); awarded = true; }
      if (!d.dot && d.vuln > 0) { bump(e, 'vuln'); items.vuln.push({ ...occ, text: `${occ.text}，易傷 ${d.vuln} 層` }); awarded = true; }
      if (d.doom) { bump(e, 'doom'); items.doom.push(occ); awarded = true; }
      if (d.wall) { bump(e, 'wall'); items.wall.push({ ...occ, text: '撞到場地邊界' }); awarded = true; }
      if (!awarded) {
        if (!others.has(e.name)) others.set(e.name, { e, list: [] });
        others.get(e.name).list.push(occ);
      }
    });
  });
  $('funScope').textContent = `範圍：左邊列表 ${fights.length} 把，共 ${total} 次死亡`;
  if (!total) { body.innerHTML = '<p class="muted">這些場次都沒有人死亡，全員優秀！</p>'; return; }

  const who = (e) => `<span class="${e.me ? 'me' : ''}">${esc(e.name)}${e.job ? `（${esc(jobName(e.job))}）` : ''}${e.me ? '・我' : ''}</span>`;
  const occBtn = (o, withWho = true) =>
    `<button type="button" data-fight="${o.fightId}" data-t="${o.t}">#${o.no} ${fmtDur(o.t)} ${withWho && o.who ? esc(o.who) + ' ' : ''}<span class="cause">（${esc(o.text)}）</span></button>`;
  const cards = AWARDS.map((a) => {
    if (a.team) {
      const list = items.wipe;
      if (!list.length) return `<div class="award none"><h4>${a.icon} ${a.title}</h4><div class="desc">${a.desc}</div>從缺</div>`;
      return `<div class="award"><h4>${a.icon} ${a.title}</h4><div class="desc">${a.desc}</div><div class="winner">🏅 全隊 × ${list.length} 次</div><div class="occ">${list.map((o) => occBtn(o, false)).join('')}</div></div>`;
    }
    const ranked = [...people.values()].filter((e) => e.count[a.key]).sort((x, y) => y.count[a.key] - x.count[a.key]);
    if (!ranked.length) return `<div class="award none"><h4>${a.icon} ${a.title}</h4><div class="desc">${a.desc}</div>從缺</div>`;
    const top = ranked[0].count[a.key];
    const winners = ranked.filter((e) => e.count[a.key] === top);
    const rest = ranked.filter((e) => e.count[a.key] < top).slice(0, 5);
    const occ = a.list ? `<div class="occ">${items[a.key].map((o) => occBtn(o)).join('')}</div>` : '';
    return `<div class="award"><h4>${a.icon} ${a.title}</h4><div class="desc">${a.desc}</div>
      <div class="winner">🏅 ${winners.map(who).join('、')} × ${top} 次</div>
      ${rest.length ? `<div class="others">其他：${rest.map((e) => `${esc(e.name)} ${e.count[a.key]}`).join('、')}</div>` : ''}
      ${occ}</div>`;
  }).join('');
  const otherHtml = [...others.values()]
    .sort((x, y) => y.list.length - x.list.length)
    .map(({ e, list }) => `<div class="person"><b class="${e.me ? 'me' : ''}">${esc(e.name)}${e.job ? `（${esc(jobName(e.job))}）` : ''}${e.me ? '・我' : ''}</b> × ${list.length}<div class="occ">${list.map((o) => occBtn(o, false)).join('')}</div></div>`)
    .join('');
  body.innerHTML = `<div class="awards">${cards}</div>${otherHtml ? `<div class="fun-other"><h4>其他死法</h4>${otherHtml}</div>` : ''}`;
}
function toggleFun(show = $('funPanel').hidden) {
  $('funPanel').hidden = !show;
  $('funBtn').classList.toggle('active', show);
  if (show) {
    renderFun();
    $('funPanel').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
}
$('funBtn').addEventListener('click', () => toggleFun());
$('funClose').addEventListener('click', () => toggleFun(false));
$('funBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fight][data-t]');
  if (!b) return;
  const fightId = Number(b.dataset.fight);
  // 死亡紀錄通常比實際倒地晚 1～2 秒，所以多往前一點
  const t = Number(b.dataset.t) - 2 - state.lead;
  if (state.fightId !== fightId) await selectFight(fightId, { seek: false });
  seekFightT(t);
});

// ---------- 時間軸 ----------
// 使用者自己填的 GCD 秒數，依職業分別記住（裝備不同 GCD 就不同）；沒填回傳 null（自動推算）
function manualGcd() {
  const v = Number(lsGet('gcd:' + state.job, ''));
  return v >= 1 && v <= 3.5 ? v : null;
}
function fillGcdInput() {
  const v = manualGcd();
  $('gcdInput').value = v ? v.toFixed(2) : '';
  $('gcdInput').placeholder = '自動';
}
function renderGcdSummary(ga) {
  const el = $('gcdSummary');
  if (!ga || !ga.gaps.length) { el.textContent = ''; return; }
  const parts = [ga.manual ? `GCD ${ga.gcd.toFixed(2)} 秒（自己填的）` : `GCD 約 ${ga.gcd.toFixed(2)} 秒（推算）`, `共 ${ga.count} 個 GCD`];
  parts.push(ga.idleCount ? `空轉 ${ga.idleCount} 次、合計 ${ga.idleTotal.toFixed(1)} 秒` : '沒有空轉');
  if (ga.stops) parts.push(`停手 ${ga.stops} 次（轉場等，不算空轉）`);
  el.textContent = parts.join(' · ');
  el.classList.toggle('warn', ga.idleTotal >= 3);
}
function iconHtml(c) {
  if (state.px < 9) return '<div class="tickmark"></div>';
  const pet = c.kind === 'pet' ? ' pet-mark' : c.kind === 'item' ? ' item-mark' : '';
  if (c.icon) return `<img class="icon${pet}" src="${esc(c.icon)}" alt="" loading="lazy" draggable="false">`;
  return `<div class="icon icon-fallback${pet}">${esc((c.name || '?').slice(0, 2))}</div>`;
}
const KIND_LABEL = { gcd: 'GCD', ogcd: 'oGCD', pet: '寵物', item: '藥品', other: '' };
function tip(c, kindLabel) {
  const cast = c.castStart != null && !c.cancelled && c.t > c.castStart ? `（讀條 ${(c.t - c.castStart).toFixed(1)} 秒）` : '';
  return `${fmtDur(c.t, true)}  ${c.name}${c.detail ? `（${c.detail}）` : ''}  ${kindLabel}${cast}${c.cancelled ? '  ※讀條取消或被打斷' : ''}`;
}
// 依序把元素分到不重疊的列，回傳列號
function assignRows(items, startOf, endOf, maxRows) {
  const rowsEnd = [];
  return items.map((it) => {
    const s = startOf(it);
    let r = rowsEnd.findIndex((e) => e <= s);
    if (r === -1) r = rowsEnd.length < maxRows ? rowsEnd.length : rowsEnd.indexOf(Math.min(...rowsEnd));
    rowsEnd[r] = endOf(it);
    return r;
  });
}

function renderTimeline() {
  const d = state.data;
  const px = state.px;
  const t0 = Math.floor(Math.min(0, d.preStart) - 1); // 開打前的起手也要畫出來
  state.t0 = t0;
  const X = (t) => (t - t0) * px;
  const W = Math.max(400, Math.ceil(X(d.duration)) + 60);
  const canvas = $('tlCanvas');
  canvas.style.width = W + 'px';
  const parts = [];

  // 時間刻度
  const step = [5, 10, 15, 30, 60, 120].find((s) => s * px >= 64) || 120;
  const minor = step >= 30 ? step / 3 : step / 5;
  let ruler = '';
  for (let t = Math.ceil(t0 / minor) * minor; t <= d.duration + 0.01; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    ruler += `<div class="tick${major ? '' : ' minor'}" style="left:${X(t)}px">${major ? fmtDur(t) : ''}</div>`;
  }
  parts.push(`<div class="lane ruler" id="laneRuler">${ruler}</div>`);

  // 目標區段（依主要敵人推測）
  let ph = '';
  d.phases.forEach((p, i) => {
    const end = d.phases[i + 1]?.t ?? d.duration;
    ph += `<div class="phase-block" style="left:${X(p.t)}px;width:${(end - p.t) * px}px" title="${esc(p.name)}：${fmtDur(p.t, true)} 起">${esc(p.name)}</div>`;
  });
  parts.push(`<div class="lane phase">${ph}</div>`);

  // Boss 招式（讀條長度畫成色條，重疊時分到兩列）
  const boss = d.boss;
  const bossRows = assignRows(
    boss,
    (c) => X(c.castStart ?? c.t),
    (c) => Math.max(X(c.t), X(c.castStart ?? c.t) + 6 + Math.min(c.name.length * 11, 140)),
    2
  );
  let bh = '';
  boss.forEach((c, i) => {
    const s = c.castStart ?? c.t - 0.3;
    const w = Math.max(4, (c.t - s) * px);
    bh += `<div class="ev boss-bar${c.cancelled ? ' cancelled' : ''}" data-t="${s}" style="left:${X(s)}px;width:${w}px;top:${3 + bossRows[i] * 21}px" title="${esc(tip(c, 'Boss'))}"><span>${esc(c.name)}</span></div>`;
  });
  parts.push(`<div class="lane boss">${bh}</div>`);

  // 我的 GCD
  const gcd = d.casts.filter((c) => c.kind === 'gcd' || c.kind === 'other');
  let gh = '';
  for (const c of gcd) {
    if (c.castStart != null && !c.cancelled && c.t > c.castStart) {
      gh += `<div class="cast-bar" style="left:${X(c.castStart)}px;width:${(c.t - c.castStart) * px}px"></div>`;
    }
    const half = px < 9 ? 1 : 12;
    gh += `<div class="ev${c.cancelled ? ' cancelled' : ''}" data-t="${c.t}" style="left:${X(c.t) - half}px;top:4px" title="${esc(tip(c, KIND_LABEL[c.kind]))}">${iconHtml(c)}</div>`;
  }
  parts.push(`<div class="lane gcd">${gh}</div>`);

  // GCD 間隔：每兩個 GCD 之間一段，空轉標紅色、停手（轉場等）灰色、死亡中暗色
  const ga = analyzeGcd(d.casts, d.deaths, state.playerId, manualGcd());
  let gp = '';
  for (const g of ga.gaps) {
    const w = (g.to - g.from) * px;
    const label =
      g.kind === 'idle' ? `+${g.idle.toFixed(1)}` : g.kind === 'stop' ? `停手 ${g.actual.toFixed(0)}s` : g.kind === 'dead' ? '死亡' : '';
    const why =
      g.kind === 'idle' ? `空轉 ${g.idle.toFixed(2)} 秒` : g.kind === 'stop' ? '停手（可能是轉場或 Boss 無法攻擊）' : g.kind === 'dead' ? '死亡中' : g.kind === 'pre' ? '開打前' : '正常';
    const title = `${fmtDur(g.from, true)}～${fmtDur(g.to, true)}  ${g.prev} → ${g.next}\n間隔 ${g.actual.toFixed(2)} 秒，最快 ${g.expected.toFixed(2)} 秒 → ${why}`;
    gp += `<div class="ev gap ${g.kind}" data-t="${g.from}" style="left:${X(g.from)}px;width:${Math.max(1, w - 1)}px" title="${esc(title)}">${label && w > 24 ? `<span>${esc(label)}</span>` : ''}</div>`;
  }
  parts.push(`<div class="lane gap">${gp}</div>`);
  state.gcdStats = ga;
  renderGcdSummary(ga);

  // 我的 oGCD 和寵物技能（太擠時分兩列）
  const ogcd = d.casts.filter((c) => c.kind === 'ogcd' || c.kind === 'pet' || c.kind === 'item');
  const size = px < 9 ? 4 : 22;
  const oRows = assignRows(ogcd, (c) => X(c.t) - size / 2, (c) => X(c.t) + size / 2 + 1, 2);
  let oh = '';
  ogcd.forEach((c, i) => {
    oh += `<div class="ev${c.cancelled ? ' cancelled' : ''}" data-t="${c.t}" style="left:${X(c.t) - (px < 9 ? 1 : 10)}px;top:${2 + oRows[i] * 23}px" title="${esc(tip(c, KIND_LABEL[c.kind]))}">${iconHtml(c)}</div>`;
  });
  parts.push(`<div class="lane ogcd">${oh}</div>`);

  // 死亡（全隊）
  let dh = '';
  let lines = '';
  for (const x of d.deaths) {
    const a = state.fight.players.find((p) => p.id === x.target);
    const who = a ? `${jobName(a.job)} ${a.name}` : x.name;
    const why = x.ability ? `（${x.ability}）` : '';
    const mine = x.target === state.playerId ? ' style="font-weight:800"' : '';
    dh += `<div class="ev death-mark" data-t="${x.t}" style="left:${X(x.t) - 4}px" title="${esc(`${fmtDur(x.t, true)}  ${who} 死亡${why}`)}"><span${mine}>✝ ${esc(x.target === state.playerId ? '我' : a ? jobName(a.job) : x.name)}</span></div>`;
    lines += `<div class="death-line" style="left:${X(x.t)}px"></div>`;
  }
  parts.push(`<div class="lane death">${dh}</div>`);

  const pre = t0 < 0 ? `<div class="prepull" style="left:0;width:${X(0)}px" title="開打前"></div>` : '';
  canvas.innerHTML = pre + parts.join('') + lines + '<div class="playhead" id="playhead" hidden></div>';
  state.events = [...boss.map((c) => c.castStart ?? c.t), ...d.casts.map((c) => c.t), ...d.deaths.map((x) => x.t)].sort((a, b) => a - b);
  if (!d.casts.length) {
    const msg = state.playerId ? '這一把沒有你的施放紀錄。' : `這一把隊伍裡沒有${jobName(state.job)}，請在上方「我的職業」選擇影片裡你玩的職業。`;
    canvas.insertAdjacentHTML('beforeend', `<div class="tl-empty" style="position:absolute;top:118px;left:8px">${esc(msg)}</div>`);
  }
  renderPlayhead(true);
}

$('tlCanvas').addEventListener('click', (e) => {
  if (!state.data) return;
  const ev = e.target.closest('.ev');
  if (ev) { seekFightT(Number(ev.dataset.t) - state.lead); return; }
  if (e.target.closest('#laneRuler')) {
    const rect = $('tlCanvas').getBoundingClientRect();
    seekFightT((e.clientX - rect.left) / state.px + state.t0);
  }
});

function renderPlayhead(forceScroll = false) {
  const ph = $('playhead');
  if (!ph || !state.data) return;
  const t = videoToFightT(curVideo());
  if (t == null || !isFinite(t) || t < state.t0 - 5 || t > state.data.duration + 5) { ph.hidden = true; return; }
  ph.hidden = false;
  const x = (Math.max(state.t0, t) - state.t0) * state.px;
  ph.style.left = x + 'px';
  const sc = $('tlScroll');
  if (state.follow && (isPlaying() || forceScroll)) {
    if (x < sc.scrollLeft + 40 || x > sc.scrollLeft + sc.clientWidth * 0.8) sc.scrollLeft = x - sc.clientWidth * 0.3;
  }
}

// ---------- 播放中的更新 ----------
function fightAtWall(ms) {
  return zoneFights().find((f) => ms >= state.report.startTime + f.startTime - 3000 && ms <= state.report.startTime + f.endTime + 2000);
}
let lastTick = 0;
function tick(now) {
  requestAnimationFrame(tick);
  if (now - lastTick < 80) return;
  lastTick = now;
  const v = curVideo();
  $('videoTime').textContent = fmtVideo(v);
  if (!state.cal || !state.report || !isFinite(v)) {
    $('wallTime').textContent = '--:--:--';
    $('fightPos').textContent = '';
    return;
  }
  const wall = videoToWall(v);
  $('wallTime').textContent = fmtClock(wall, true);
  const f = fightAtWall(wall);
  document.querySelectorAll('.pull').forEach((b) => b.classList.toggle('playing', Boolean(f) && Number(b.dataset.fight) === f.id));
  if (f) {
    const t = (wall - state.report.startTime - f.startTime) / 1000;
    const idx = zoneFights().indexOf(f) + 1;
    const seg = f.phases ? [...f.phases].reverse().find((p) => p.t <= t) : null;
    $('fightPos').textContent = `第 ${idx} 把${seg ? ' · ' + seg.name : ''} · ${fmtDur(t, true)}`;
    if (state.autoSwitch && isPlaying() && f.id !== state.fightId) selectFight(f.id, { seek: false });
  } else {
    $('fightPos').textContent = '把與把之間';
  }
  renderPlayhead();
}
requestAnimationFrame(tick);

// ---------- 筆記 ----------
let noteTimer = null;
function loadNote() {
  const ta = $('noteInput');
  ta.disabled = false;
  ta.value = state.notes[noteKey(state.fight)] || '';
  $('noteSaved').textContent = '';
}
$('noteInput').addEventListener('input', () => {
  clearTimeout(noteTimer);
  const key = noteKey(state.fight);
  const text = $('noteInput').value;
  $('noteSaved').textContent = '儲存中…';
  noteTimer = setTimeout(async () => {
    if (text.trim()) state.notes[key] = text;
    else delete state.notes[key];
    if (saveStore(key, text.trim() ? text : null)) $('noteSaved').textContent = '已儲存';
    renderPulls();
  }, 600);
});

// ---------- 事件繫結 ----------
$('loadForm').addEventListener('submit', (e) => { e.preventDefault(); loadAll(); });
$('refreshBtn').addEventListener('click', async () => { await refreshLogList({ ask: true }); if (state.report) loadAll(); });
$('pickDirBtn').hidden = !canPickDir;
$('pickDirBtn').addEventListener('click', pickDir);
$('pickFileBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  const f = $('fileInput').files[0];
  if (!f) return;
  state.logs = [{ name: f.name, size: f.size, mtime: f.lastModified, file: f }, ...state.logs.filter((l) => !l.file)];
  renderLogList();
  $('fileInput').value = '';
});
$('sampleBtn').addEventListener('click', async () => {
  try {
    const blob = await (await fetch('sample/Network_sample.log')).blob();
    const f = new File([blob], 'Network_sample.log', { lastModified: Date.now() });
    state.logs = [{ name: f.name, size: f.size, mtime: f.lastModified, file: f }, ...state.logs.filter((l) => !l.file)];
    renderLogList();
    $('videoInput').value = '';
    loadAll();
  } catch (e) {
    banner('讀取範例失敗：' + e.message);
  }
});
$('daySel').addEventListener('change', () => {
  state.day = $('daySel').value;
  state.fight = null;
  refreshFilters();
});
$('helpBtn').addEventListener('click', () => $('helpDlg').showModal());
$('pullList').addEventListener('click', (e) => {
  const b = e.target.closest('.pull');
  if (b) selectFight(Number(b.dataset.fight));
});
$('zoneSel').addEventListener('change', () => {
  state.zone = $('zoneSel').value;
  renderPulls();
  const first = zoneFights()[0];
  if (first && !zoneFights().includes(state.fight)) selectFight(first.id, { seek: false });
});
$('rangeOnly').addEventListener('change', () => {
  state.rangeOnly = $('rangeOnly').checked;
  if (state.report) refreshFilters();
});
$('gcdInput').addEventListener('change', () => {
  const raw = $('gcdInput').value.trim();
  const v = Number(raw);
  if (!raw) lsSet('gcd:' + state.job, '');
  else if (v >= 1 && v <= 3.5) lsSet('gcd:' + state.job, String(v));
  else { banner('GCD 秒數請填 1～3.5 之間的數字，例如 2.42；清空就是自動推算。'); fillGcdInput(); return; }
  fillGcdInput();
  if (state.data) renderTimeline();
});
$('jobSel').addEventListener('change', () => {
  state.job = $('jobSel').value;
  fillGcdInput();
  if (!$('funPanel').hidden) renderFun();
  lsSet('job', state.job);
  if (state.videoId) lsSet('job:' + state.videoId, state.job);
  if (state.fight) loadFightData();
});
$('zoom').value = state.px;
$('zoom').addEventListener('input', () => {
  const sc = $('tlScroll');
  const centerT = (sc.scrollLeft + sc.clientWidth / 2) / state.px;
  state.px = Number($('zoom').value);
  lsSet('zoom', state.px);
  if (state.data) { renderTimeline(); sc.scrollLeft = centerT * state.px - sc.clientWidth / 2; }
});
$('leadSel').value = String(state.lead);
$('leadSel').addEventListener('change', () => { state.lead = Number($('leadSel').value); lsSet('lead', state.lead); });
$('follow').addEventListener('change', () => { state.follow = $('follow').checked; });
$('autoSwitch').addEventListener('change', () => { state.autoSwitch = $('autoSwitch').checked; });
$('rateSel').addEventListener('change', () => { if (playerReady()) player.setPlaybackRate(Number($('rateSel').value)); });

function togglePlay() {
  if (!playerReady()) return;
  if (isPlaying()) player.pauseVideo();
  else player.playVideo();
}
function stepVideo(d) {
  if (!playerReady()) return;
  if (Math.abs(d) < 0.5) player.pauseVideo();
  seekVideo(curVideo() + d);
}
$('playBtn').addEventListener('click', togglePlay);
document.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => stepVideo(Number(b.dataset.step))));

$('calClockBtn').addEventListener('click', () => {
  if (!state.report) { banner('請先載入 log。'); return; }
  if (!playerReady()) { banner('請先載入影片。'); return; }
  const ms = resolveClock($('clockInput').value, curVideo());
  if (ms == null) { banner('時間格式看不懂，請輸入像 21:47 或 21:47:00 的時間。'); return; }
  setCal(curVideo(), ms);
});
$('calPullBtn').addEventListener('click', () => {
  if (!state.fight) { banner('請先載入 log 並選一把。'); return; }
  if (!playerReady()) { banner('請先載入影片。'); return; }
  setCal(curVideo(), fightWall(state.fight, 0));
});
document.querySelectorAll('[data-nudge]').forEach((b) =>
  b.addEventListener('click', () => {
    if (!state.cal) { needCal(); return; }
    setOffset(calOffset() + Number(b.dataset.nudge));
  })
);
$('offsetInput').addEventListener('change', (e) => {
  const v = Number(e.target.value);
  if (!Number.isFinite(v)) { updateOffsetUI(); return; }
  setOffset(v);
});
$('offsetReset').addEventListener('click', () => setOffset(0));
$('calDateSel').addEventListener('change', () => shiftCalDays(Number($('calDateSel').value)));
$('rangeHint').addEventListener('click', (e) => {
  if (e.target.id !== 'fixDateLink') return;
  e.preventDefault();
  $('calPanel').open = true;
  $('calDateRow').classList.add('flash');
  setTimeout(() => $('calDateRow').classList.remove('flash'), 1600);
  $('calDateRow').scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('calDateSel').focus();
});

function jumpEvent(dir) {
  if (!state.events.length) return;
  const t = videoToFightT(curVideo());
  if (t == null) { needCal(); return; }
  const target = dir > 0 ? state.events.find((x) => x > t + 0.15) : [...state.events].reverse().find((x) => x < t - 0.15);
  if (target != null) seekFightT(target);
}
function nextDeath() {
  const t = videoToFightT(curVideo());
  if (t == null || !state.data) return;
  const x = state.data.deaths.find((dd) => dd.t - state.lead > t + 0.2);
  if (x) seekFightT(x.t - state.lead);
}
function shiftPull(dir) {
  if (!state.report) return;
  const fs = zoneFights();
  const n = fs[fs.indexOf(state.fight) + dir];
  if (n) selectFight(n.id);
}
document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey || $('helpDlg').open) return;
  const map = {
    ' ': togglePlay,
    arrowleft: () => jumpEvent(-1),
    arrowright: () => jumpEvent(1),
    j: () => stepVideo(-5),
    l: () => stepVideo(5),
    ',': () => stepVideo(-FRAME),
    '.': () => stepVideo(FRAME),
    d: nextDeath,
    n: () => shiftPull(1),
    p: () => shiftPull(-1),
    '[': () => setOffset(calOffset() - 0.1),
    ']': () => setOffset(calOffset() + 0.1),
    '{': () => setOffset(calOffset() - 1),
    '}': () => setOffset(calOffset() + 1),
  };
  const fn = map[e.key.toLowerCase()];
  if (fn) { e.preventDefault(); fn(); }
});

// ---------- 讀取畫面時鐘自動校正 ----------
let ocrCancel = false;
function loadBox() {
  try { return JSON.parse(lsGet('clockBox', 'null')); } catch { return null; }
}
function showOcrBox(box) {
  const el = $('ocrBoxShow');
  if (!box) { el.style.display = 'none'; return; }
  Object.assign(el.style, { display: 'block', left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.w * 100 + '%', height: box.h * 100 + '%' });
}
function setOcrStatus(msg) { $('ocrStatus').textContent = msg; }

// 讓播放器真的顯示某個時間點的畫面（還沒播放過的影片只 seek 會是黑畫面）
async function showFrameAt(t) {
  player.seekTo(t, true);
  player.playVideo();
  for (let i = 0; i < 40 && player.getPlayerState() !== YT.PlayerState.PLAYING; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 300));
  player.pauseVideo();
  player.seekTo(t, true);
  await new Promise((r) => setTimeout(r, 300));
}

// 挑一個「確定是某一分鐘中間（約 :30）」的影片秒數當參考點
function pickReference() {
  const len = state.videoLen || player.getDuration?.() || 0;
  let base = curVideo();
  if (!(base > 5) && state.fight && state.cal) base = wallToVideo(fightWall(state.fight, 0));
  if (!(base > 5)) base = 60;
  if (state.cal) {
    const minuteStart = Math.floor(videoToWall(base) / 60000) * 60000;
    let v = wallToVideo(minuteStart + 30000);
    if (v < 2) v += 60;
    if (len && v + 62 > len) v -= 60;
    return { vRef: v, flipWall: Math.floor(videoToWall(v) / 60000) * 60000 + 60000 };
  }
  return { vRef: Math.min(Math.max(base, 30), len ? len - 65 : base), flipWall: null };
}

async function runClockCalibration({ repick = false } = {}) {
  if (!state.report) { banner('請先載入 log。'); return; }
  if (!playerReady()) { banner('請先載入影片。'); return; }
  banner(null);
  ocrCancel = false;
  const wasMuted = player.isMuted();
  const resumeAt = curVideo();
  const ref = pickReference();
  const wrap = $('player').parentElement;
  const cap = new ClockCal.TabCapture(wrap);
  let box = repick ? null : loadBox();
  // 換成沒有按鈕的播放器（YouTube 暫停時右上角的按鈕會蓋住時鐘）
  const useCleanPlayer = async () => {
    await createPlayer(state.videoId, { clean: true, start: ref.vRef });
    player.mute();
    await showFrameAt(ref.vRef);
  };
  const askShare = async () => {
    $('ocrShield').hidden = false;
    showOcrBox(box);
    setOcrStatus('請在瀏覽器的分享視窗選擇「這個分頁」…');
    await cap.start();
    showOcrBox(null); // 框線會被一起擷取進畫面，開始讀取前要拿掉
  };

  document.body.classList.add('ocr-mode');
  try {
    // 瀏覽器只允許在使用者按下按鈕（或放開滑鼠）後幾秒內要求分享畫面，所以順序要注意
    if (box) {
      await askShare();
      setOcrStatus('準備播放器…');
      await useCleanPlayer();
    } else {
      await useCleanPlayer();
      box = await ClockCal.pickBox(wrap, loadBox());
      if (!box) throw Object.assign(new Error('已取消。'), { silent: true });
      lsSet('clockBox', JSON.stringify(box));
      await askShare();
    }

    // YouTube 嵌入播放器回報的時間是一段一段更新的，播放中用經過的時間補上，讓取樣的時間點更準
    let lastT = { v: null, at: 0 };
    const io0 = () => ({
      seek: (t) => { if (ocrCancel) throw new Error('已取消。'); lastT = { v: null, at: 0 }; player.seekTo(t, true); },
      play: () => player.playVideo(),
      pause: () => player.pauseVideo(),
      setRate: (r) => player.setPlaybackRate(r),
      time: () => {
        const v = player.getCurrentTime();
        const now = performance.now();
        if (v !== lastT.v) { lastT = { v, at: now }; return v; }
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) return v;
        return v + Math.min(0.3, ((now - lastT.at) / 1000) * player.getPlaybackRate());
      },
      grab: () => { if (ocrCancel) throw new Error('已取消。'); return cap.grab(box); },
      log: setOcrStatus,
    });

    // 決定搜尋範圍：哪些時間確定是「舊分鐘」、哪些確定是「新分鐘」、跳分在哪個區間
    let plan;
    let flipWall = ref.flipWall;
    const span = (a, b, n = 7) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
    if (flipWall != null) {
      // 已有校正（誤差在十幾秒內）：vRef 預估在 :30，跳分在 vRef+13～vRef+47 之間
      const v = ref.vRef;
      plan = { oldTimes: span(v - 12, v + 12), newTimes: span(v + 48, v + 72), lo: v + 13, hi: v + 47 };
    } else {
      // 沒有任何校正：
      // 1. 讀出影片 a 秒時畫面上是幾點幾分（OCR，讀不出來就請使用者輸入一次）
      // 2. a 秒一定是這一分鐘、a+60 秒一定是下一分鐘；用畫面比對找出跳分在哪 5 秒內
      // 3. 再用一般的方式精確定位
      const len0 = state.videoLen || player.getDuration?.() || 0;
      const a = Math.max(60, Math.min(ref.vRef, len0 ? len0 - 130 : ref.vRef));
      setOcrStatus('讀取時鐘數字中（第一次需要下載 OCR 元件）…');
      await showFrameAt(a);
      await new Promise((r) => setTimeout(r, 300));
      const g = cap.grab(box);
      const r = await ClockOCR.readCanvas(g.src, ...g.rect).catch((e) => ({ clock: null, text: e.message }));
      let text = r.clock ? `${r.clock.h}:${pad(r.clock.m)}` : '';
      if (!r.clock) {
        console.warn('[OCR] 讀不出時間：', r.text);
        text = prompt('OCR 讀不出時鐘，請輸入畫面上顯示的時間（例如 21:47）：', '') || '';
        if (!text) throw Object.assign(new Error('已取消。'), { silent: true });
      }
      const ms = resolveClock(text, a);
      if (ms == null) throw new Error(`時間「${text}」看不懂。`);
      const minute = Math.round(ms / 60000);
      const win = await ClockCal.coarseWindow({ ...io0(), log: setOcrStatus }, a);
      plan = { oldTimes: span(win.hi - 58, win.lo - 2), newTimes: span(win.hi + 2, win.lo + 58), lo: win.lo - 0.5, hi: win.hi + 0.5 };
      flipWall = (minute + 1) * 60000;
    }

    const io = io0();
    // 找兩次相鄰的跳分（相隔 60 秒）互相驗證；不一致就不套用，避免錯的校正
    const len = state.videoLen || player.getDuration?.() || 0;
    setOcrStatus('第 1 次跳分搜尋…');
    const logStep = (n) => (msg) => setOcrStatus(`第 ${n}/2 次：${msg}`);
    const r1 = await ClockCal.findFlip({ ...io, log: logStep(1) }, plan);
    const dir = len && r1.flip + 112 > len ? -1 : 1; // 影片快結束就改找前一次跳分
    const f = r1.flip + dir * 60;
    // 第 2 次跳分和第 1 次相鄰：中間那一分鐘的參考畫面直接沿用，不用重取
    const plan2 = dir > 0
      ? { oldPatches: r1.newRefs, newTimes: span(f + 8, f + 50), lo: f - 3, hi: f + 3 }
      : { oldTimes: span(f - 50, f - 8), newPatches: r1.oldRefs, lo: f - 3, hi: f + 3 };
    const r2 = await ClockCal.findFlip({ ...io, log: logStep(2) }, plan2);
    // 每次結果換算回「第 1 次跳分」的位置來比較
    const found = [r1.flip, r2.flip - dir * 60];
    let pair = Math.abs(found[1] - found[0]) <= 0.35 ? [found[0], found[1]] : null;
    if (!pair) {
      // 不一致：再找第 3 次，取互相吻合的兩次
      const f3 = r1.flip + dir * 120;
      const inRange = f3 > 60 && (!len || f3 + 52 < len);
      if (inRange) {
        const plan3 = { oldTimes: span(f3 - 50, f3 - 8), newTimes: span(f3 + 8, f3 + 50), lo: f3 - 3, hi: f3 + 3 };
        const r3 = await ClockCal.findFlip({ ...io, log: (m) => setOcrStatus(`第 3 次（驗證）：${m}`) }, plan3);
        const third = r3.flip - dir * 120;
        if (Math.abs(third - found[1]) <= 0.35) pair = [found[1], third];
        else if (Math.abs(third - found[0]) <= 0.35) pair = [found[0], third];
      }
    }
    if (!pair) {
      throw new Error('幾次跳分的結果對不起來，畫面可能不夠清楚（建議把畫質調到 1080p、時鐘框緊一點）。原本的校正沒有變更。');
    }
    const gap = Math.abs(pair[1] - pair[0]);
    const flip = (pair[0] + pair[1]) / 2;
    const precision = Math.max(gap / 2, 0.05);
    const before = state.cal ? videoToWall(0) : null;
    await setCal(flip, flipWall);
    const shift = before != null ? (videoToWall(0) - before) / 1000 : null;
    banner(
      `已用畫面時鐘校正：影片 ${fmtVideo(flip)} 是 ${fmtClock(flipWall)}（誤差約 ±${precision.toFixed(2)} 秒）` +
        (shift != null ? `，比原本的校正${shift >= 0 ? '晚' : '早'} ${Math.abs(shift).toFixed(1)} 秒。` : '。'),
      'info'
    );
  } catch (e) {
    if (!e.silent) {
      banner('畫面時鐘校正失敗：' + e.message);
      showOcrDebug(cap, box, e.message);
    }
  } finally {
    cap.stop();
    $('ocrShield').hidden = true;
    document.body.classList.remove('ocr-mode');
    await restorePlayer(resumeAt, wasMuted);
  }
}
// 失敗時顯示程式實際截到的畫面
function showOcrDebug(cap, box, message) {
  const d = cap.debug;
  if (!d?.full) return;
  const body = $('ocrDebugBody');
  body.innerHTML = '';
  body.appendChild(Object.assign(d.full, { className: 'full' }));
  const shots = document.createElement('div');
  shots.className = 'shots';
  d.shots.forEach((s, i) => {
    const fig = document.createElement('figure');
    fig.appendChild(s.canvas);
    fig.appendChild(document.createTextNode(`${i + 1}（畫面 ${s.frames}${s.ok ? '' : '・太暗'}）`));
    shots.appendChild(fig);
  });
  body.appendChild(shots);
  const info = document.createElement('pre');
  const st = d.settings || {};
  info.textContent = [
    `錯誤：${message}`,
    `裁切到播放器：${d.cropped ? '是' : '否'}　分享類型：${st.displaySurface || '?'}`,
    `截到的畫面大小：${d.size?.join('×')}　時鐘位置：${d.rect?.join(', ')}`,
    `框選（比例）：${box ? [box.x, box.y, box.w, box.h].map((v) => v.toFixed(3)).join(', ') : '?'}`,
    `視窗：${innerWidth}×${innerHeight}　縮放：${devicePixelRatio}　收到的畫面數：${cap.frames ?? '?'}`,
    `瀏覽器：${navigator.userAgent}`,
  ].join('\n');
  body.appendChild(info);
  $('ocrDebugDlg').showModal();
}
// 換回一般播放器，停在原本的位置
async function restorePlayer(at, wasMuted) {
  await createPlayer(state.videoId, { start: at });
  try {
    if (wasMuted) player.mute();
    if (at > 0) { player.seekTo(at, true); player.pauseVideo(); }
  } catch { /* 播放器尚未就緒 */ }
}
$('ocrCalBtn').addEventListener('click', () => runClockCalibration());
$('ocrBoxBtn').addEventListener('click', () => runClockCalibration({ repick: true }));
$('ocrCancelBtn').addEventListener('click', () => { ocrCancel = true; setOcrStatus('取消中…'); });

// ---------- 啟動 ----------
(async () => {
  $('videoInput').value = lsGet('video', '');
  if (canPickDir) state.dir = await loadHandle('logDir');
  await refreshLogList();
  if (!state.logs.length) {
    banner(
      canPickDir
        ? '第一次使用：按「選擇資料夾…」選 ACT 的 log 資料夾（通常是 %APPDATA%\\Advanced Combat Tracker\\FFXIVLogs），之後會自動列出每天的 log。'
        : '請按「選擇檔案…」選擇當天的 Network_*.log（ACT 的 log 通常在 %APPDATA%\\Advanced Combat Tracker\\FFXIVLogs）。',
      'info'
    );
  }
})();
