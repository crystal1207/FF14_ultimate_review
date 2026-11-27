// 用 Node 測試 log 解析（和網頁用同一份程式）：node tools/parse-test.js <Network_*.log>
import { createReadStream } from 'node:fs';
import { createParser, lineSplitter } from '../public/lib/actlog.js';

const file = process.argv[2];
if (!file) { console.error('用法：node tools/parse-test.js <Network_*.log>'); process.exit(1); }
const t0 = Date.now();
const parser = createParser({ title: file });
const split = lineSplitter(parser.push);
const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
for await (const chunk of stream) split.write(chunk);
split.end();
const r = parser.finish();
console.log(`${r.lines} 行、${r.fights.length} 把、${((Date.now() - t0) / 1000).toFixed(1)} 秒、記錄者 ${r.me?.name}`);
for (const f of r.fights.slice(-5)) console.log(` #${f.id} ${f.zone} ${new Date(f.startTime).toLocaleString()} ${f.kill ? '擊殺' : f.boss?.name + ' ' + f.boss?.hp?.toFixed(1)}`);
