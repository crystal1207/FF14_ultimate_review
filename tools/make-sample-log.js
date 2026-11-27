// 產生一份格式與 ACT／IINACT 相同的「範例」Network log，用來試用或測試解析器。
// 用法：node tools/make-sample-log.js [輸出路徑]
// 內容是程式產生的假資料（角色名稱都標示「範例」），不是真實的戰鬥紀錄。
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || path.join('public', 'sample', 'Network_sample.log');

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function ts(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}0000${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}
const hex = (n) => n.toString(16).toUpperCase();
const lines = [];
const emit = (ms, ...fields) => lines.push({ ms, text: [...fields.slice(0, 1), ts(ms), ...fields.slice(1), '0123456789abcdef'].join('|') });

const ME = { id: '10FF0001', name: '範例騎士', job: 19 };
const PARTY = [
  ME,
  { id: '10FF0002', name: '範例戰士', job: 21 },
  { id: '10FF0003', name: '範例白魔', job: 24 },
  { id: '10FF0004', name: '範例學者', job: 28 },
  { id: '10FF0005', name: '範例武士', job: 34 },
  { id: '10FF0006', name: '範例龍騎', job: 22 },
  { id: '10FF0007', name: '範例詩人', job: 23 },
  { id: '10FF0008', name: '範例黑魔', job: 25 },
];
const FAIRY = { id: '40001001', name: '朝日小仙女', owner: '10FF0004' };
const BOSS_A = { id: '40002001', name: '範例Boss甲', max: 60_000_000 };
const BOSS_B = { id: '40002002', name: '範例Boss乙', max: 80_000_000 };
let seq = 0x1000;

function ability(ms, type, src, id, name, tgt, { tHp = 0, tMax = 0, idx = 0, count = 1, s } = {}) {
  const f = new Array(54).fill('0');
  f[0] = type; f[1] = src.id; f[2] = src.name; f[3] = hex(id); f[4] = name; f[5] = tgt.id; f[6] = tgt.name;
  f[23] = String(tHp); f[24] = String(tMax);
  f[43] = hex(s ?? seq); f[44] = String(idx); f[45] = String(count);
  emit(ms, ...f);
}

const start = new Date();
start.setHours(21, 30, 0, 0);
let t = start.getTime();

emit(t, '01', '3C4', '絕境戰（範例）');
emit(t, '02', ME.id, ME.name);
for (const p of PARTY) emit(t, '03', p.id, p.name, hex(p.job), '64', '0000', '28', 'Sample', '0', '0', '100000', '100000', '10000', '10000', '0', '0', '0', '0', '0', '0');
emit(t, '03', FAIRY.id, FAIRY.name, '00', '64', FAIRY.owner, '00', '', '0', '0', '50000', '50000', '0', '0', '0', '0', '0', '0', '0', '0');
for (const b of [BOSS_A, BOSS_B]) emit(t, '03', b.id, b.name, '00', '64', '0000', '00', '', '0', '0', String(b.max), String(b.max), '0', '0', '0', '0', '0', '0', '0', '0');
emit(t, '11', '8', ...PARTY.map((p) => p.id));
emit(t, '33', '80037586', '40000001', '1C20', '00', '00', '00');

const DURS = [95, 240, 410, 520];
const PHASE2 = 150_000;
const COMBO = [[9, '先鋒劍'], [15, '暴亂劍'], [3539, '王權劍'], [16460, '贖罪劍']];
const BOSS_SKILLS = [['範例・全體大範圍', 5], ['範例・雙坦死刑', 5], ['範例・分攤', 4], ['範例・踩塔', 6]];

DURS.forEach((dur, pi) => {
  const kill = pi === DURS.length - 1;
  const t0 = t + 60_000;
  // 倒數時的起手（開打前 1.5 秒）
  ability(t0 - 1500, '21', ME, 7531, '鐵壁', ME, { s: ++seq });
  const end = t0 + dur * 1000;
  let hpA = BOSS_A.max;
  let hpB = BOSS_B.max;
  // 我的 GCD
  let g = t0;
  let ci = 0;
  while (g < end - 500) {
    const inP2 = g - t0 >= PHASE2;
    const boss = inP2 ? BOSS_B : BOSS_A;
    if (rand() < 0.12) {
      emit(g, '20', ME.id, ME.name, hex(7384), '聖靈', boss.id, boss.name, '1.50', '0', '0', '0', '0');
      if (rand() < 0.15) {
        emit(g + 900, '23', ME.id, ME.name, hex(7384), '聖靈', 'Cancelled');
        g += 1200;
        continue;
      }
      g += 1500;
      ability(g, '21', ME, 7384, '聖靈', boss, { tHp: inP2 ? hpB : hpA, tMax: boss.max, s: ++seq });
      g += 1000;
    } else {
      const [id, name] = COMBO[ci++ % COMBO.length];
      if (inP2) hpB -= 140_000; else hpA -= 140_000;
      ability(g, '21', ME, id, name, boss, { tHp: Math.max(1, inP2 ? hpB : hpA), tMax: boss.max, s: ++seq });
      g += rand() < 0.05 ? 3400 : 2500;
    }
    // 隊友持續打王（讓 HP 下降、維持戰鬥狀態）
    const mate = PARTY[1 + Math.floor(rand() * 7)];
    if (inP2) hpB -= 900_000; else hpA -= 1_400_000;
    ability(g - 300, '21', mate, 0x1000 + Math.floor(rand() * 10), '範例技能', boss, { tHp: Math.max(1, inP2 ? hpB : hpA), tMax: boss.max, s: ++seq });
  }
  // 我的 oGCD
  for (let s = 7000; t0 + s < end; s += 60_000) {
    const boss = s >= PHASE2 ? BOSS_B : BOSS_A;
    ability(t0 + s, '21', ME, 20, '戰逃反應', ME, { s: ++seq });
    ability(t0 + s + 1250, '21', ME, 7383, '安魂祈禱', boss, { s: ++seq });
    ability(t0 + s + 3700, '21', ME, 23, '厄運流轉', boss, { s: ++seq });
    ability(t0 + s + 4000, '21', ME, 25747, '偿赎剑', boss, { s: ++seq });
  }
  // 小仙女的技能（寵物）
  for (let s = 20_000; t0 + s < end; s += 45_000) ability(t0 + s, '22', FAIRY, 16538, '仙光的低語', ME, { s: ++seq });
  // Boss 讀條，AoE 打全隊
  let b = t0 + 9000;
  let k = 0;
  while (b < end - 4000) {
    const boss = b - t0 >= PHASE2 ? BOSS_B : BOSS_A;
    const [name, cast] = BOSS_SKILLS[k++ % BOSS_SKILLS.length];
    const id = 0x7000 + k % 4;
    emit(b, '20', boss.id, boss.name, hex(id), name, boss.id, boss.name, cast.toFixed(2), '0', '0', '0', '0');
    const hit = b + cast * 1000 + 300;
    const s = ++seq;
    PARTY.forEach((p, i) => ability(hit, '22', { id: '40003000', name: '' }, id, name, p, { idx: i, count: 8, s }));
    b = hit + 8000 + Math.floor(rand() * 8000);
  }
  if (!kill) {
    const v1 = PARTY[1 + Math.floor(rand() * 7)];
    const v2 = PARTY[(PARTY.indexOf(v1) + 3) % 8];
    ability(end - 9200, '21', BOSS_A, 0x7100, '範例・即死雷', v1, { s: ++seq });
    emit(end - 9000, '25', v1.id, v1.name, BOSS_A.id, BOSS_A.name);
    ability(end - 2700, '21', BOSS_B, 0x7101, '範例・全滅波', v2, { s: ++seq });
    emit(end - 2500, '25', v2.id, v2.name, BOSS_B.id, BOSS_B.name);
    emit(end + 6000, '33', '80037586', '40000005', '00', '00', '00', '00');
    emit(end + 12000, '33', '80037586', '40000006', '1C20', '00', '00', '00');
  } else {
    emit(end, '25', BOSS_B.id, BOSS_B.name, ME.id, ME.name);
    emit(end + 500, '33', '80037586', '40000003', '00', '00', '00', '00');
  }
  t = end + 15000;
});

lines.sort((a, b) => a.ms - b.ms);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, lines.map((l) => l.text).join('\r\n') + '\r\n', 'utf8');
console.log(`已產生 ${lines.length} 行 → ${out}`);
