// 身位判定。
// 傷害效果旗標的最高位元組，是這一下的「加成百分比」（FFLogs 叫 bonusPercent）：
// 身位、連擊、buff 讓威力變高多少。同一個技能打到身位時這個數字會比較高，但確切數值會隨連擊、buff、版本改變，
// 所以不寫死公式，而是看「這個數字出現時，玩家是不是真的站在正確的位置」來判斷哪些數字代表打到。
// 下面的預設表是用實際 log 統計出來的（7.x 版本），讀 log 時還會再用這份 log 的資料重新學一次。

// 技能 ID → 需要的位置（rear 背面、flank 側面）。用 ID 判斷，任何語言的客戶端都通用
export const POSITIONAL = {
  // 武士：月光、花車
  7481: 'rear', 7482: 'flank',
  // 忍者：旋風刃、強甲破點突
  2255: 'rear', 3563: 'flank',
  // 龍騎：櫻花怒放、櫻花繚亂、龍尾大迴旋、龍牙龍爪
  88: 'rear', 25772: 'rear', 3556: 'rear', 3554: 'flank',
  // 武僧：破碎拳、崩拳、虎襲崩拳
  66: 'rear', 56: 'flank', 36947: 'flank',
  // 鐮刀：縊殺、絞決、縊殺處刑、絞決處刑
  24383: 'rear', 24382: 'flank', 36971: 'rear', 36970: 'flank',
  // 蛇：參之牙【背擊】【背裂】【側擊】【側裂】
  34612: 'rear', 34613: 'rear', 34610: 'flank', 34611: 'flank',
};

// 預設：技能 ID → { hit: 打到的數值, miss: 沒打到的數值 }
const h = (...a) => new Set(a);
const VPR = { hit: h(0x30, 0x32, 0x3c, 0x3f), miss: h(0x28, 0x2a, 0x34, 0x38) };
const DRG_WT = { hit: h(0x16, 0x3a, 0x42), miss: h(0x35, 0x3d) };
const RPR = { hit: h(0x09, 0x0a, 0x0b, 0x0d), miss: h() };
const PRIOR = {
  7481: { hit: h(0x46, 0x48), miss: h(0x41, 0x43) },
  7482: { hit: h(0x46, 0x48), miss: h(0x41, 0x43) },
  2255: { hit: h(0x2a, 0x32, 0x34, 0x36, 0x3f, 0x46), miss: h(0x24, 0x2d, 0x40) },
  3563: { hit: h(0x34, 0x41, 0x48), miss: h(0x2d, 0x3a) },
  88: { hit: h(0x3d), miss: h(0x36) },
  25772: { hit: h(0x3a), miss: h(0x35) },
  3556: DRG_WT,
  3554: DRG_WT,
  66: { hit: h(0x0e, 0x11), miss: h() },
  56: { hit: h(0x0d, 0x14), miss: h() },
  36947: { hit: h(0x0b), miss: h() },
  24383: RPR, 24382: RPR,
  36971: { hit: h(0x07), miss: h() },
  36970: { hit: h(0x07), miss: h() },
  34612: VPR, 34613: VPR, 34610: VPR, 34611: VPR,
};

// 玩家相對於目標面向的位置。heading 是 log 裡的面向（弧度，0 朝南、順時針為正）
export function zoneOf(tx, ty, heading, px, py) {
  if (![tx, ty, heading, px, py].every(Number.isFinite)) return null;
  const vx = px - tx;
  const vy = py - ty;
  const len = Math.hypot(vx, vy);
  if (len < 0.01) return null;
  const ang = (Math.acos(Math.max(-1, Math.min(1, (vx * Math.sin(heading) + vy * Math.cos(heading)) / len))) * 180) / Math.PI;
  return ang > 135 ? 'rear' : ang < 45 ? 'front' : 'flank';
}

// 從這份 log 統計：stats[技能 ID][數值] = { n, ok }（ok：站在正確位置或開著真北）
export function learn(stats) {
  const table = {};
  for (const id of Object.keys(POSITIONAL)) {
    const p = PRIOR[id] || { hit: h(), miss: h() };
    const t = { hit: new Set(p.hit), miss: new Set(p.miss) };
    for (const [b, s] of Object.entries(stats[id] || {})) {
      const v = Number(b);
      if (v === 0 || s.n < 8) continue;
      const rate = s.ok / s.n;
      if (rate >= 0.5) { t.hit.add(v); t.miss.delete(v); }
      else if (rate <= 0.25) { t.miss.add(v); t.hit.delete(v); }
    }
    table[id] = t;
  }
  return table;
}

// 判定一下：回傳 { need, ok, how, zone }。how：log＝遊戲紀錄判定、tn＝開真北、guess＝看站位推測
export function judge(table, p) {
  const need = POSITIONAL[p.id];
  const t = table[p.id];
  const zoneOk = p.zone ? p.zone === need : null;
  let ok = null;
  let how = 'log';
  if (p.bonus === 0) ok = false; // 完全沒有加成 → 身位沒打到
  else if (t?.hit.has(p.bonus)) ok = true;
  else if (t?.miss.has(p.bonus)) ok = false;
  if (ok === null) {
    if (p.tn) { ok = true; how = 'tn'; }
    else if (zoneOk !== null) { ok = zoneOk; how = 'guess'; }
    else return null;
  } else if (ok && p.tn && zoneOk === false) how = 'tn';
  return { need, ok, how, zone: p.zone };
}
