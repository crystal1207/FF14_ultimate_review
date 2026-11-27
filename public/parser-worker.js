// 在背景執行緒解析 log，避免大檔案讓畫面卡住。解析結果留在這裡，主畫面需要哪一把再來拿。
import { createParser, lineSplitter } from './lib/actlog.js?v=dev';

let report = null;

async function parse(file) {
  const parser = createParser({ title: file.name });
  const split = lineSplitter(parser.push);
  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let read = 0;
  let lastPost = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    split.write(value);
    read += value.length; // 字元數，當作大概的進度
    const now = performance.now();
    if (now - lastPost > 250) { lastPost = now; postMessage({ type: 'progress', ratio: Math.min(0.99, read / file.size) }); }
  }
  split.end();
  report = parser.finish();
  return summary(report);
}

// 給主畫面的摘要（不含事件）
function summary(r) {
  return {
    title: r.title,
    lines: r.lines,
    startTime: r.startTime,
    endTime: r.endTime,
    me: r.me,
    fights: r.fights.map((f) => ({
      id: f.id,
      name: f.zone,
      startTime: f.startTime - r.startTime,
      endTime: f.endTime - r.startTime,
      kill: f.kill,
      boss: f.boss,
      players: f.players,
      phases: f.phases,
      deaths: f.deaths.length,
    })),
  };
}

// 一把的事件：自己的技能（含寵物）、敵人招式、死亡，時間換成「開打後幾秒」
function fight(fightId, playerId) {
  const f = report?.fights.find((x) => x.id === fightId);
  if (!f) throw new Error('找不到這一把，請重新載入 log');
  const rel = (ms) => (ms - f.startTime) / 1000;
  const cast = (c) => ({
    id: c.id,
    t: rel(c.ts),
    castStart: c.castStart != null ? rel(c.castStart) : undefined,
    cancelled: c.cancelled || undefined,
    name: c.name,
    pet: c.src !== playerId || undefined,
  });
  return {
    fightId,
    playerId,
    duration: rel(f.endTime),
    phases: f.phases,
    mine: f.friendly.filter((c) => c.src === playerId || c.owner === playerId).map(cast),
    boss: f.enemy.map((c) => ({ ...cast(c), pet: undefined })),
    deaths: f.deaths.map((d) => deathOut(d, f)),
  };
}

const deathOut = (d, f) => ({
  t: (d.ts - f.startTime) / 1000,
  target: d.target,
  name: d.name,
  killer: d.killer,
  ability: d.by,
  byAgo: d.byAgo,
  hpPct: d.hpPct,
  vuln: d.vuln,
  doom: d.doom,
});

// 好幾把的死亡（死法統計用）
function deaths(fightIds) {
  const out = {};
  for (const id of fightIds) {
    const f = report?.fights.find((x) => x.id === id);
    if (!f) continue;
    out[id] = f.deaths.map((d) => deathOut(d, f));
  }
  return out;
}

onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    let result;
    if (type === 'parse') result = await parse(e.data.file);
    else if (type === 'fight') result = fight(e.data.fightId, e.data.playerId);
    else if (type === 'deaths') result = deaths(e.data.fightIds);
    postMessage({ id, result });
  } catch (err) {
    postMessage({ id, error: err.message || String(err) });
  }
};
