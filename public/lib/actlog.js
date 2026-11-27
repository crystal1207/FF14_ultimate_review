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

const WANT = new Set(['01', '02', '03', '11', '20', '21', '22', '23', '25', '33']);
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
  const lastHit = new Map(); // 玩家 id -> 最後一次被敵人打的招式

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

  function addCast(list, ts, src, f, castInfo) {
    const owner = actors[src]?.owner;
    list.push({
      ts,
      src,
      owner: owner && isPlayer(owner) ? owner : undefined,
      id: parseInt(f[4], 16),
      name: f[5] || '',
      castStart: castInfo ? castInfo.ts : undefined,
    });
  }

  function push(line) {
    lines++;
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
          if (enemy && isPlayer(tgt) && f[5]) lastHit.set(tgt, f[5]);
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
          addCast(pull ? pull.friendly : recentFriendly, ts, src, f, castInfo);
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
          pull.deaths.push({ ts, target: f[2], name: f[3], by: lastHit.get(f[2]) || '' });
        }
        break;
      case '33': {
        const cmd = (f[3] || '').toUpperCase();
        if (cmd === '40000003' || cmd === '40000002') endPull(ts, true);
        else if (cmd === '40000005' || cmd === '4000000F' || cmd === '40000010') endPull(ts, false);
        break;
      }
    }
  }
  function finish() {
    if (pull) endPull(lastCombat + 1);
    return {
      title,
      lines,
      startTime: firstTs ?? 0,
      endTime: lastTs ?? 0,
      me,
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
