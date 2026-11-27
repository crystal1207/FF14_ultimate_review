// 用 XIVAPI v2 查技能分類（GCD／oGCD）與圖示，結果快取在瀏覽器（localStorage）。
// ActionCategory：2 = 魔法、3 = 戰技 → GCD；4 = 能力 → oGCD；1 = 自動攻擊；其他（道具等）→ other。
const BASE = 'https://v2.xivapi.com/api';
const CACHE_KEY = 'ur.actions.v2';

function categoryKind(cat) {
  if (cat === 2 || cat === 3) return 'gcd';
  if (cat === 4) return 'ogcd';
  if (cat === 1) return 'auto';
  return 'other';
}
const iconUrl = (path) => (path ? `${BASE}/asset?path=${encodeURIComponent(path)}&format=png` : null);

let cache = null;
function loadCache() {
  if (cache) return cache;
  try { cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { cache = {}; }
  return cache;
}
function saveCache() {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* 空間不足時只用記憶體快取 */ }
}

// 回傳 { [id]: { kind, icon, name, recast, cast, gcd } | null }；查不到的 id 記為 null 避免重查
export async function lookupActions(ids) {
  const c = loadCache();
  const want = [...new Set(ids)].filter((id) => id > 0 && id < 1_000_000 && !(id in c));
  for (let i = 0; i < want.length; i += 100) {
    const chunk = want.slice(i, i + 100);
    try {
      const res = await fetch(`${BASE}/sheet/Action?rows=${chunk.join(',')}&fields=Name,Icon,ActionCategory@as(raw),Recast100ms,Cast100ms,CooldownGroup,AdditionalCooldownGroup`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const got = new Set();
      for (const row of json.rows ?? []) {
        const f = row.fields ?? {};
        const cat = f['ActionCategory@as(raw)'] ?? 0;
        c[row.row_id] = {
          kind: categoryKind(cat),
          icon: iconUrl(f.Icon?.path_hr1 || f.Icon?.path),
          name: f.Name || '',
          recast: (f.Recast100ms || 0) / 10, // 冷卻秒數（GCD 技能通常是 2.5）
          cast: (f.Cast100ms || 0) / 10, // 讀條秒數
          gcd: f.CooldownGroup === 58 || f.AdditionalCooldownGroup === 58, // 58 ＝ 共用 GCD 的冷卻群組
        };
        got.add(row.row_id);
      }
      for (const id of chunk) if (!got.has(id)) c[id] = null;
    } catch (e) {
      console.warn('[xivapi] 查詢失敗：', e.message); // 網路失敗時不寫入快取，下次再試
    }
  }
  if (want.length) saveCache();
  const out = {};
  for (const id of new Set(ids)) out[id] = c[id] ?? null;
  return out;
}

// ---------- 道具（爆發藥等） ----------
// log 裡用道具會記成「0x2000000 ＋ 道具編號」，HQ 再加 1000000，例如 20FF5EB ＝ HQ 的 Grade 3 Gemdraught of Strength
export function itemFromAbility(id) {
  if (id < 0x2000000 || id >= 0x3000000) return null;
  let item = id - 0x2000000;
  const hq = item >= 1_000_000;
  if (hq) item -= 1_000_000;
  return { item, hq };
}
// 坐騎召喚（0xD000000 ＋ 編號），時間軸上不顯示
export const isMountAbility = (id) => id >= 0xd000000 && id < 0xe000000;

const ITEM_CACHE_KEY = 'ur.items.v1';
const MEDICINE = 44; // ItemUICategory：藥品
let itemCache = null;

// 回傳 { [道具編號]: { name, icon, medicine } | null }
export async function lookupItems(itemIds) {
  if (!itemCache) {
    try { itemCache = JSON.parse(localStorage.getItem(ITEM_CACHE_KEY) || '{}'); } catch { itemCache = {}; }
  }
  const c = itemCache;
  const want = [...new Set(itemIds)].filter((id) => id > 0 && !(id in c));
  for (let i = 0; i < want.length; i += 100) {
    const chunk = want.slice(i, i + 100);
    try {
      const res = await fetch(`${BASE}/sheet/Item?rows=${chunk.join(',')}&fields=Name,Icon,ItemUICategory@as(raw)`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const got = new Set();
      for (const row of json.rows ?? []) {
        const f = row.fields ?? {};
        c[row.row_id] = { name: f.Name || '', icon: iconUrl(f.Icon?.path_hr1 || f.Icon?.path), medicine: f['ItemUICategory@as(raw)'] === MEDICINE };
        got.add(row.row_id);
      }
      for (const id of chunk) if (!got.has(id)) c[id] = null;
    } catch (e) {
      console.warn('[xivapi] 道具查詢失敗：', e.message);
    }
  }
  if (want.length) {
    try { localStorage.setItem(ITEM_CACHE_KEY, JSON.stringify(c)); } catch { /* 空間不足 */ }
  }
  const out = {};
  for (const id of new Set(itemIds)) out[id] = c[id] ?? null;
  return out;
}
