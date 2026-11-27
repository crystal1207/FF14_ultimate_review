// GCD 間隔分析：每兩個 GCD 之間實際隔多久、理論上最快能多快，差太多就是空轉。
//
// 理論間隔 ＝ max(這個技能的冷卻 × 技速／詠速係數, 實際讀條時間 + 0.1)
// - 冷卻與讀條秒數來自 XIVAPI（例如大部分 GCD 是 2.5 秒）
// - 技速／詠速係數無法從 log 直接得知，用這一把裡「基礎 2.5 秒的 GCD 連續施放」的常見間隔推算
// - 讀條被 即刻詠唱、連續詠唱 等縮短時，log 裡看得到實際讀條時間，所以用實際值

export const IDLE_MIN = 0.3; // 比理論間隔慢這麼多才算空轉（網路延遲、能力技穿插通常在這以內）
export const STOP_MIN = 8; // 空了這麼久通常是轉場或 Boss 無法攻擊，另外標成「停手」

// GCD 鎖定時間和 XIVAPI 冷卻欄位不同的技能（秒，不受技速／詠速影響）
const FIXED_LOCK = {
  15999: 1, 16000: 1, 16001: 1, 16002: 1, // 舞者 舞步
  15997: 1.5, 15998: 1.5, // 標準舞步、技巧舞步（本身冷卻 30／120 秒）
  2259: 0.5, 2261: 0.5, 2263: 0.5, 18805: 0.5, 18806: 0.5, 18807: 0.5, // 忍者 結印
};
// 這個 GCD 之後最快多久能按下一個 GCD
function gcdLock(a, speed) {
  if (FIXED_LOCK[a.id]) return FIXED_LOCK[a.id];
  const r = a.recast > 0 ? a.recast : 2.5;
  if (r > 4) return 2.5 * speed; // 有自己冷卻的 GCD（例如 30 秒一次），共用的 GCD 還是 2.5 秒
  if (r >= 2.5 - 0.01) return r * speed; // 2.5、3.0 秒的 GCD 受技速／詠速影響
  return r; // 1.5 秒等特殊 GCD（忍術、舞步結束）
}

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

// casts：時間軸上的技能（已含 XIVAPI 的 recast／gcd），deaths：這一把的死亡
// gcdOverride：使用者自己填的 GCD 秒數（2.5 秒技能的實際冷卻）；沒填就自動推算
export function analyzeGcd(casts, deaths, playerId, gcdOverride = null) {
  const list = casts
    .filter((c) => c.gcd && c.kind !== 'pet' && !c.cancelled)
    .map((c) => ({ ...c, start: c.castStart ?? c.t, castTime: c.castStart != null ? Math.max(0, c.t - c.castStart) : 0 }))
    .sort((a, b) => a.start - b.start);
  // 同一個技能被記兩次（間隔極短）時只留第一個
  const gcds = list.filter((c, i) => i === 0 || c.start - list[i - 1].start > 0.4);
  if (gcds.length < 2) return { speed: null, gcd: null, gaps: [], idleCount: 0, idleTotal: 0, stops: 0, manual: false };

  // 推算技速／詠速：基礎 2.5 秒、沒有長讀條的 GCD，接著下一個 GCD 的常見間隔
  const samples = [];
  for (let i = 0; i < gcds.length - 1; i++) {
    const a = gcds[i];
    if (Math.abs(a.recast - 2.5) > 0.01 || a.castTime > 1.9) continue;
    const d = gcds[i + 1].start - a.start;
    if (d > 1.5 && d < 2.8) samples.push(d);
  }
  // 取偏快的一側（正常打的時候大多貼著冷卻；偏慢的是空轉）
  const sorted = samples.sort((x, y) => x - y);
  const base = sorted.length >= 5 ? sorted[Math.floor(sorted.length * 0.3)] : median(sorted) ?? 2.5;
  const manual = gcdOverride > 0;
  const speed = manual ? gcdOverride / 2.5 : Math.min(1.02, Math.max(0.6, base / 2.5));

  const myDeaths = deaths.filter((d) => d.target === playerId).map((d) => d.t);
  const gaps = [];
  for (let i = 0; i < gcds.length - 1; i++) {
    const a = gcds[i];
    const b = gcds[i + 1];
    const recast = gcdLock(a, speed);
    const expected = Math.max(recast, a.castTime > 0 ? a.castTime + 0.1 : 0);
    const actual = b.start - a.start;
    const idle = actual - expected;
    let kind = 'ok';
    if (a.start < 0) kind = 'pre'; // 開打前（倒數時的起手）不算
    else if (myDeaths.some((t) => t > a.start && t < b.start)) kind = 'dead';
    else if (idle >= STOP_MIN) kind = 'stop';
    else if (idle >= IDLE_MIN) kind = 'idle';
    gaps.push({ from: a.start, to: b.start, expected, actual, idle, kind, prev: a.name, next: b.name });
  }
  const idles = gaps.filter((g) => g.kind === 'idle');
  return {
    speed,
    manual,
    gcd: 2.5 * speed,
    gaps,
    count: gcds.length,
    idleCount: idles.length,
    idleTotal: idles.reduce((s, g) => s + g.idle, 0),
    stops: gaps.filter((g) => g.kind === 'stop').length,
  };
}
