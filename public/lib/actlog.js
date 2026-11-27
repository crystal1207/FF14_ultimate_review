import { POSITIONAL, zoneOf } from './positional.js?v=dev';
// 解析 ACT／IINACT 的 Network_*.log（FFXIV 網路紀錄），切出每一把並整理事件。
// 格式參考 cactbot 的 LogGuide：每行以 | 分隔，第 0 欄是類型，第 1 欄是含時區的時間戳。
// 不依賴瀏覽器或 Node 的 API：createParser() 逐行餵入，瀏覽器（Web Worker）和 Node 都能用。

// ACT 的職業代碼（十六進位）→ 職業英文代號（與前端 jobs.js 的 key 相同）
const JOB_BY_ID = {
  1: 'Gladiator', 2: 'Pugilist', 3: 'Marauder', 4: 'Lancer', 5: 'Archer', 6: 'Conjurer', 7: 'Thaumaturge',
  19: 'Paladin', 20: 'Monk', 21: 'Warrior', 22: 'Dragoon', 23: 'Bard', 24: 'WhiteMage', 25: 'BlackMage',
  26: 'Arcanist', 27: 'Summoner', 28: 'Scholar', 29: 'Rogue', 30: 'Ninja', 31: 'Machinist', 32: 'DarkKnight',
  33: 'Astrologian', 34: 'Samurai', 35: 'RedMage', 36: 'BlueMage', 37: 'Gunbreaker', 38: 'Dancer',
  39: 'Reaper', 40: 'Sage', 41: 'Viper', 42: 'Pictomancer',
};

const WANT = new Set(['01', '02', '03', '11', '20', '21', '22', '23', '24', '25', '26', '30', '33']);
// 死法統計用的狀態（各語言客戶端的名稱）
const VULN_NAMES = new Set([
  '受傷加重', '魔法受傷加重', '物理受傷加重',
  'Vulnerability Up', 'Magic Vulnerability Up', 'Physical Vulnerability Up',
  '被ダメージ上昇', '被魔法ダメージ上昇', '被物理ダメージ上昇',
  '易伤', '魔法易伤', '物理易伤',
]);
const DOOM_NAMES = new Set(['死亡宣告', 'Doom', '死の宣告', 'Verhängnis', 'Glas']);
const TANK_JOBS = new Set(['Paladin', 'Warrior', 'DarkKnight', 'Gunbreaker', 'Gladiator', 'Marauder']);
const AUTO_IDS = new Set([0x7, 0x8]); // 自動攻擊、自動射擊
const AUTO_NAMES = new Set(['attack', 'shot', '攻撃', '攻擊', '攻击', '射撃', '射擊', '射击', '']);
const PRE_PULL_MS = 20_000; // 開打前保留多久的技能（倒數時的起手）
const IDLE_END_MS = 30_000; // 這麼久沒有戰鬥就視為結束
const MIN_PULL_MS = 15_000;

// "2021-07-27T12:48:22.4630000-04:00" → epoch 毫秒
function parseTs(s) {
  if (s.length > 27 && s[19] === '.') return Date.parse(s.slice(0, 23) + s.slice(27));
  return Date.parse(s);
}
const isPlayer = (id) => id.startsWith('10');
const isEnemy = (id) => id.startsWith('4');

export function createParser({ title = 'log' } = {}) {

  const actors = {}; // id -> { name, job, owner }
  let me = null; // { id, name }
  let zone = '';
  let party = [];
  let firstTs = null;
  let lastTs = null;
  let lines = 0;

  const fights = [];
  let pull = null; // 進行中的這一把
  let lastCombat = 0;
  const recentFriendly = []; // 開打前的技能暫存
  const casting = new Map(); // src:abilityId -> { ts, castTime, name, cancelled? }
  const seenSeq = new Map(); // src:abilityId:seq -> true（AoE 多目標只算一次）
  const lastHit = new Map(); // 玩家 id -> { name, ts, hp, max, vuln } 最後一次被敵人打的招式（hp 是被打之前的血量）
  const statuses = new Map(); // 玩家 id -> Map(狀態名稱 -> { ts, until, stacks })，只記易傷和死亡宣告
  const doomExpired = new Map(); // 玩家 id -> 死亡宣告時間到的時間
  const pos = new Map(); // 玩家 id -> { x, y } 最新座標（判斷撞到場地邊界用）
  const lastDot = new Map(); // 玩家 id -> 最後一次被持續傷害（DoT）打到的時間
  const trueNorth = new Set(); // 開著真北的玩家
  const enemyHits = {}; // 敵人招式名稱 -> { casts, hits, tank }（找出死刑：幾乎只打坦克的單體招式）
  const enemyCastNames = new Set(); // 敵人有讀條的招式名稱
  const posStats = {}; // 身位技：技能 ID -> 加成數值 -> { n, ok }（之後用來學哪些數值代表打到身位）

  const isFriendlySource = (id) => {
    if (isPlayer(id)) return true;
    const owner = actors[id]?.owner;
    return Boolean(owner && isPlayer(owner));
  };

  function startPull(ts) {
    pull = {
      zone,
      start: ts,
      end: ts,
      kill: false,
      party: [...party],
      friendly: recentFriendly.filter((c) => c.ts >= ts - PRE_PULL_MS),
      enemy: [],
      deaths: [],
      enemies: new Map(), // 敵人 id -> { name, cur, max, lastT }
      targets: [], // { ts, id } 隊伍打到的敵人（用來推測目標切換）
    };
    recentFriendly.length = 0;
  }

  function endPull(ts, kill = false) {
    if (!pull) return;
    pull.end = Math.min(ts, lastCombat + 5000);
    pull.kill = kill;
    if (pull.end - pull.start >= MIN_PULL_MS || kill) fights.push(finishPull(pull));
    pull = null;
  }

  function finishPull(p) {
    const ids = new Set(p.party.filter(isPlayer));
    for (const c of p.friendly) {
      const owner = actors[c.src]?.owner;
      ids.add(owner && isPlayer(owner) ? owner : c.src);
    }
    const players = [...ids].filter((id) => isPlayer(id) && actors[id]);
    // Boss：結束前 15 秒內被打過、最大 HP 最高的敵人
    let boss = null;
    let bossAll = null;
    for (const e of p.enemies.values()) {
      if (!bossAll || e.max > bossAll.max) bossAll = e;
      if (e.lastT >= p.end - 15_000 && (!boss || e.max > boss.max)) boss = e;
    }
    boss = boss || bossAll;
    p.enemy.sort((a, b) => a.ts - b.ts);
    p.friendly.sort((a, b) => a.ts - b.ts);
    return {
      zone: p.zone,
      startTime: p.start,
      endTime: p.end,
      kill: p.kill,
      boss: boss ? { name: boss.name, hp: boss.max ? (boss.cur / boss.max) * 100 : null } : null,
      players: players.map((id) => ({ id, name: actors[id].name, job: actors[id].job })),
      phases: targetSegments(p),
      friendly: p.friendly,
      enemy: p.enemy,
      deaths: p.deaths,
    };
  }

  // 依「隊伍正在打的主要敵人」切出區段，當作階段的參考（ACT 紀錄沒有官方的階段資訊）。
  function targetSegments(p) {
    const maxHp = Math.max(0, ...[...p.enemies.values()].map((e) => e.max));
    const segs = [];
    for (const { ts, id } of p.targets) {
      const e = p.enemies.get(id);
      if (!e || e.max < maxHp * 0.3) continue;
      const last = segs[segs.length - 1];
      if (last && last.name === e.name) { last.until = ts; continue; }
      segs.push({ name: e.name, from: ts, until: ts });
    }
    const kept = segs.filter((s, i) => s.until - s.from >= 5000 || i === 0);
    const merged = [];
    for (const s of kept) {
      const last = merged[merged.length - 1];
      if (last && last.name === s.name) continue;
      merged.push(s);
    }
    return merged.map((s, i) => ({ id: i + 1, name: s.name, t: (i === 0 ? 0 : s.from - p.start) / 1000 }));
  }

  function readPos(line) {
    const f = line.split('|');
    if (f[2] !== 'Change' || !isPlayer(f[3])) return;
    let p = pos.get(f[3]);
    for (let i = 4; i < f.length - 1; i += 2) {
      if (f[i] === 'PosX') { if (!p) pos.set(f[3], (p = {})); p.x = Number(f[i + 1]); }
      else if (f[i] === 'PosY') { if (!p) pos.set(f[3], (p = {})); p.y = Number(f[i + 1]); }
    }
  }

  // 撞到場地邊界（電網）：沒有兇手（被 Boss 的招式打死時兇手會是那個 Boss）、位置在場地邊緣。
  // 被擊退撞到邊界也算。現在的高難度副本場地幾乎都是以 (100, 100) 為中心、半徑或半邊長 20 碼
  function hitWall(f) {
    if (f[4] !== 'E0000000') return false;
    const p = pos.get(f[2]);
    if (!p || p.x == null || p.y == null) return false;
    const r = Math.hypot(p.x - 100, p.y - 100);
    // 座標不是每一瞬間都有紀錄，最後記到的位置常比撞牆處靠內一點；被擊退時也可能衝出邊界一點
    return r >= 17 && r <= 30;
  }

  // 身位技打在敵人身上：記下加成數值、玩家相對於目標面向的位置、有沒有開真北
  function readPositional(f, src, id) {
    const need = POSITIONAL[id];
    if (!need || !isPlayer(src) || !isEnemy(f[6])) return undefined;
    const fl = f[8] || '';
    if (fl.slice(-2) !== '03') return undefined; // 不是傷害（例如被閃避）
    const bonus = fl.length > 6 ? parseInt(fl.slice(0, fl.length - 6), 16) : 0;
    const zone = zoneOf(Number(f[30]), Number(f[31]), Number(f[33]), Number(f[40]), Number(f[41]));
    const tn = trueNorth.has(src);
    if (zone || tn) {
      const s = ((posStats[id] ||= {})[bonus] ||= { n: 0, ok: 0 });
      s.n++;
      if (tn || zone === need) s.ok++;
    }
    return { id, bonus, zone, tn };
  }

  function addCast(list, ts, src, f, castInfo, positional) {
    const owner = actors[src]?.owner;
    list.push({
      ts,
      src,
      owner: owner && isPlayer(owner) ? owner : undefined,
      id: parseInt(f[4], 16),
      name: f[5] || '',
      castStart: castInfo ? castInfo.ts : undefined,
      positional,
    });
  }

  function push(line) {
    lines++;
    // 261：角色資料變化，裡面有座標（PosX／PosY）。數量很多，只在打本中、只記玩家
    if (line.startsWith('261|')) {
      if (pull && line.includes('|10', 30)) readPos(line);
      return;
    }
    const type = line.slice(0, 2);
    if (line[2] !== '|' || !WANT.has(type)) return;
    const f = line.split('|');
    const ts = parseTs(f[1]);
    if (!Number.isFinite(ts)) return;
    if (firstTs == null) firstTs = ts;
    lastTs = ts;

    if (pull && ts - lastCombat > IDLE_END_MS) endPull(lastCombat + 1);

    switch (type) {
      case '01':
        endPull(ts);
        zone = f[3] || zone;
        break;
      case '02':
        me = { id: f[2], name: f[3] };
        break;
      case '03': {
        const job = JOB_BY_ID[parseInt(f[4], 16)] || null;
        const owner = f[6] && f[6] !== '0000' && f[6] !== '0' ? f[6] : null;
        actors[f[2]] = { name: f[3], job: isPlayer(f[2]) ? job : null, owner };
        break;
      }
      case '11': {
        const n = parseInt(f[2], 10) || 0;
        if (n > 0) party = f.slice(3, 3 + n).filter(Boolean);
        break;
      }
      case '20': {
        const castTime = parseFloat(f[8]) || 0;
        casting.set(`${f[2]}:${f[4]}`, { ts, castTime, name: f[5] });
        // 敵人讀條直接記成一條讀條條（實際傷害常由別的隱形單位打出，無法可靠配對）
        if (pull && !isFriendlySource(f[2]) && isEnemy(f[2]) && f[5]) enemyCastNames.add(f[5]);
        if (pull && !isFriendlySource(f[2]) && isEnemy(f[2]) && f[5] && !/^unknown_/i.test(f[5])) {
          const dup = pull.enemy.findLast((c) => c.name === f[5] && c.castStart != null && Math.abs(c.castStart - ts) < 800);
          if (!dup) {
            pull.enemy.push({ ts: ts + castTime * 1000, src: f[2], id: parseInt(f[4], 16), name: f[5], castStart: ts, castTime, bar: true });
          }
        }
        break;
      }
      case '23': {
        const key = `${f[2]}:${f[4]}`;
        const c = casting.get(key);
        casting.delete(key);
        if (!c) break;
        if (isFriendlySource(f[2])) {
          const rec = { ts: c.ts, src: f[2], id: parseInt(f[4], 16), name: f[5] || c.name, castStart: c.ts, cancelled: true };
          (pull ? pull.friendly : recentFriendly).push(rec);
        } else if (pull) {
          const bar = pull.enemy.findLast((e) => e.bar && e.src === f[2] && e.castStart === c.ts);
          if (bar) bar.cancelled = true;
        }
        break;
      }
      case '21':
      case '22': {
        const src = f[2];
        const tgt = f[6];
        const abilityId = parseInt(f[4], 16);
        const friendly = isFriendlySource(src);
        const enemy = !friendly && isEnemy(src);

        // 戰鬥判定：隊伍打敵人，或敵人打隊伍
        const combat = (friendly && isEnemy(tgt)) || (enemy && isPlayer(tgt));
        if (combat) {
          if (!pull) startPull(ts);
          lastCombat = ts;
        }
        if (pull) {
          if (friendly && isEnemy(tgt)) {
            const max = Number(f[25]);
            if (max > 0) {
              const e = pull.enemies.get(tgt) || { name: f[7], cur: 0, max: 0, lastT: 0 };
              e.cur = Number(f[24]);
              e.max = max;
              e.lastT = ts;
              e.name = f[7] || e.name;
              pull.enemies.set(tgt, e);
              const lt = pull.targets[pull.targets.length - 1];
              if (!lt || lt.id !== tgt || ts - lt.ts > 1000) pull.targets.push({ ts, id: tgt });
            }
          }
          if (enemy && isPlayer(tgt) && f[5]) {
            // 被打的這一刻身上有沒有易傷（同一瞬間才上的不算，那是這一招本身附加的）
            let vuln = 0;
            for (const [n, s] of statuses.get(tgt) || []) {
              if (VULN_NAMES.has(n) && s.ts < ts - 50 && s.until > ts) vuln = Math.max(vuln, s.stacks || 1);
            }
            lastHit.set(tgt, { name: f[5], ts, hp: Number(f[24]) || 0, max: Number(f[25]) || 0, vuln });
            const eh = (enemyHits[f[5]] ||= { casts: 0, hits: 0, tank: 0 });
            eh.hits++;
            if (TANK_JOBS.has(actors[tgt]?.job)) eh.tank++;
            if (!f[45] || f[45] === '0') eh.casts++;
          }
        }

        // 同一次施放打到多個目標時只記一次
        const seq = f[44];
        const idx = f[45];
        if (idx !== undefined && idx !== '0' && idx !== '') break;
        if (seq) {
          const k = `${src}:${f[4]}:${seq}`;
          if (seenSeq.has(k)) break;
          seenSeq.set(k, true);
          if (seenSeq.size > 5000) seenSeq.clear();
        }
        if (AUTO_IDS.has(abilityId) || AUTO_NAMES.has((f[5] || '').toLowerCase())) break;

        const key = `${src}:${f[4]}`;
        let castInfo = casting.get(key);
        if (castInfo && ts - castInfo.ts > castInfo.castTime * 1000 + 3000) castInfo = null;
        casting.delete(key);

        if (friendly) {
          addCast(pull ? pull.friendly : recentFriendly, ts, src, f, castInfo, readPositional(f, src, abilityId));
          if (!pull && recentFriendly.length > 200) recentFriendly.splice(0, 100);
        } else if (enemy && pull) {
          if (/^unknown_/i.test(f[5])) break;
          // 讀條結果、或多個分身同時放同一招 → 不重複記
          const dup = pull.enemy.findLast(
            (c) => c.name === f[5] && (c.bar ? ts >= c.castStart && ts - c.ts < 3000 : Math.abs(ts - c.ts) < 800)
          );
          if (dup) break;
          addCast(pull.enemy, ts, src, f, null);
        }
        break;
      }
      case '25':
        if (pull && isPlayer(f[2])) {
          const lh = lastHit.get(f[2]);
          const de = doomExpired.get(f[2]);
          // 最後一下是持續傷害（DoT）：DoT 跳在最後一次被招式打到之後，而且離死亡很近
          const dt = lastDot.get(f[2]);
          const dot = dt != null && ts - dt < 4000 && (!lh || dt >= lh.ts);
          doomExpired.delete(f[2]);
          // byAgo：最後一次被打到是死亡前幾秒（太久代表可能是 DoT、debuff 或摔落）
          // 注意：死亡紀錄通常比實際倒地晚 1～2 秒
          pull.deaths.push({
            ts,
            target: f[2],
            name: f[3],
            job: actors[f[2]]?.job || null,
            killer: f[5] || '',
            by: lh?.name || '',
            byAgo: lh ? (ts - lh.ts) / 1000 : null,
            hpPct: lh && lh.max > 0 ? lh.hp / lh.max : null,
            vuln: lh?.vuln || 0,
            doom: de != null && ts - de < 5000,
            dot,
            wall: !dot && hitWall(f),
          });
        }
        break;
      case '24': {
        // 持續傷害／回復：24|時間|目標ID|目標|DoT 或 HoT|狀態ID|數值(16進位)|…
        if (f[4] === 'DoT' && isPlayer(f[2]) && parseInt(f[6], 16) > 0) lastDot.set(f[2], ts);
        break;
      }
      case '26': {
        // 獲得狀態：26|時間|狀態ID|名稱|秒數|來源ID|來源|目標ID|目標|層數
        const name = f[3];
        const tgt = f[7];
        if (f[2] === '4E2') trueNorth.add(tgt); // 真北
        if (!isPlayer(tgt) || !(VULN_NAMES.has(name) || DOOM_NAMES.has(name))) break;
        let m = statuses.get(tgt);
        if (!m) statuses.set(tgt, (m = new Map()));
        m.set(name, { ts, until: ts + (parseFloat(f[4]) || 9999) * 1000, stacks: parseInt(f[9], 16) || 1 });
        break;
      }
      case '30': {
        // 失去狀態：死亡宣告在預定時間結束 ＝ 時間到（之後就會死）
        if (f[2] === '4E2') trueNorth.delete(f[7]);
        const m = statuses.get(f[7]);
        const s = m?.get(f[3]);
        if (!s) break;
        if (DOOM_NAMES.has(f[3]) && Math.abs(ts - s.until) < 1500) doomExpired.set(f[7], ts);
        m.delete(f[3]);
        break;
      }
      case '33': {
        const cmd = (f[3] || '').toUpperCase();
        if (cmd === '40000003' || cmd === '40000002') endPull(ts, true);
        else if (cmd === '40000005' || cmd === '4000000F' || cmd === '40000010') endPull(ts, false);
        break;
      }
    }
  }
  // 死刑：有讀條、每次只打 1～2 人、被打的幾乎都是坦克的招式
  function markBusters() {
    const busters = new Set();
    for (const [name, h] of Object.entries(enemyHits)) {
      if (AUTO_NAMES.has(name.toLowerCase()) || !enemyCastNames.has(name)) continue;
      if (h.casts >= 4 && h.hits / h.casts <= 2.2 && h.tank / h.hits >= 0.75) busters.add(name);
    }
    for (const fight of fights) {
      for (const d of fight.deaths) {
        d.buster = !d.dot && busters.has(d.by) && d.job != null && !TANK_JOBS.has(d.job) && d.byAgo != null && d.byAgo <= 3;
      }
    }
  }

  function finish() {
    if (pull) endPull(lastCombat + 1);
    markBusters();
    return {
      title,
      lines,
      startTime: firstTs ?? 0,
      endTime: lastTs ?? 0,
      me,
      posStats,
      fights: fights.map((x, i) => ({ id: i + 1, ...x })),
    };
  }

  return { push, finish };
}

// 把一段段的文字（串流讀到的區塊）切成一行行餵給 parser
export function lineSplitter(onLine) {
  let rest = '';
  return {
    write(chunk) {
      const text = rest + chunk;
      let start = 0;
      let i;
      while ((i = text.indexOf('\n', start)) !== -1) {
        let end = i;
        if (end > start && text.charCodeAt(end - 1) === 13) end--;
        onLine(text.slice(start, end));
        start = i + 1;
      }
      rest = text.slice(start);
    },
    end() {
      if (rest) onLine(rest.endsWith(String.fromCharCode(13)) ? rest.slice(0, -1) : rest);
      rest = '';
    },
  };
}
