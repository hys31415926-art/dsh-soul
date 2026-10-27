#!/usr/bin/env node
/**
 * style-report — 读 <数据目录>/metrics/*.jsonl，按 tag / 渠道 / 任务态给语体指标。
 *
 * 用法：
 *   node scripts/style-report.mjs                       # 默认读 ~/.dsh/dsh-soul/metrics
 *   node scripts/style-report.mjs --dir <数据目录>       # 指定数据目录
 *   node scripts/style-report.mjs --week                # 只看最近 7 天
 *
 * 指标含义：
 *   句长   平均每句多少字（越大越像一坨话）
 *   无标点 整段没有句末标点的比例（电报体的直接指纹）
 *   空格黏连 每百字出现多少次「汉字 空格 汉字」（用空格代替标点的量）
 *   清单   每段平均几个项目符号/标题（工作腔的直接指纹）
 *   语气词 每百字几个呀嘛啦呢（人格还在不在）
 *   称呼   每百字几个「主人」
 *   注入   注入块的平均字数与去重指纹数（看每轮是否在反复变）
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const dir = argOf('--dir') || join(homedir(), '.dsh', 'dsh-soul');
const weekOnly = argv.includes('--week');
const metricsDir = join(dir, 'metrics');
if (!existsSync(metricsDir)) {
  console.log('还没有指标文件：' + metricsDir + '（插件重启后开始记录）');
  process.exit(0);
}

const since = weekOnly ? Date.now() - 7 * 86400000 : 0;
const rows = [];
for (const file of readdirSync(metricsDir).filter((f) => f.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(metricsDir, file), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line);
      if (new Date(row.t).getTime() >= since) rows.push(row);
    } catch { /* 半行不参与统计 */ }
  }
}

const pad = (s, n) => String(s).padEnd(n, ' ');
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');

function summarize(list) {
  const n = list.length;
  if (!n) return null;
  const avg = (f) => list.reduce((a, b) => a + f(b), 0) / n;
  const inj = list.filter((r) => r.inj);
  return {
    n,
    chars: Math.round(avg((r) => r.out.chars)),
    sent: Math.round(avg((r) => r.out.avgSent)),
    noPunct: Math.round(avg((r) => r.out.noPunct) * 100),
    glue: +num(avg((r) => r.out.gluePer100)),
    bullets: +num(avg((r) => r.out.bullets + r.out.headers)),
    part: +num(avg((r) => r.out.partPer100), 2),
    master: +num(avg((r) => r.out.masterPer100), 2),
    injChars: inj.length ? Math.round(inj.reduce((a, r) => a + r.inj.chars, 0) / inj.length) : 0,
    injHashes: new Set(inj.map((r) => r.inj.hash)).size,
  };
}

const groups = new Map();
const key = (r) => r.tag + ' / ' + r.origin + ' / ' + r.regime;
for (const r of rows) {
  if (!groups.has(key(r))) groups.set(key(r), []);
  groups.get(key(r)).push(r);
}

console.log('数据：' + metricsDir + '（' + rows.length + ' 条' + (weekOnly ? '，最近 7 天' : '') + '）\n');
console.log(pad('分组', 28) + pad('条数', 6) + pad('字数', 6) + pad('句长', 6) + pad('无标点%', 8) + pad('空格黏连', 9) + pad('清单行', 7) + pad('语气词', 7) + pad('称呼', 6) + pad('注入字', 7) + '注入版本数');
for (const [k, list] of [...groups.entries()].sort()) {
  const s = summarize(list);
  console.log(pad(k, 28) + pad(s.n, 6) + pad(s.chars, 6) + pad(s.sent, 6) + pad(s.noPunct, 8) + pad(s.glue, 9) + pad(s.bullets, 7) + pad(s.part, 7) + pad(s.master, 6) + pad(s.injChars, 7) + s.injHashes);
}

const dupes = rows.length ? (rows.filter((r) => r.inj).length - new Set(rows.filter((r) => r.inj).map((r) => r.inj.hash)).size) : 0;
if (rows.length) console.log('\n注入块逐轮变化：' + rows.filter((r) => r.inj).length + ' 轮里有 ' + dupes + ' 轮文本和上一版不同');
