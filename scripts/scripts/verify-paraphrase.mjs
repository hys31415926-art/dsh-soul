/**
 * 10 条换说法的验收测试：同一个意思换个说法，看记忆能不能被找到。
 *
 * 对照两组：
 * - 字面：只做 LIKE 匹配（当前检索的主路径）
 * - 语义：本地 bge-small-zh 向量余弦
 *
 * 用法：node scripts/verify-paraphrase.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from '@huggingface/transformers';

const DB = 'C:/Users/HP/.dsh/dsh-soul/soul.db';
const CACHE = 'C:/Users/HP/.dsh/dsh-soul/models';

/** 每条：换个说法的问题 + 期望命中的记忆 id（至少一个） */
const CASES = [
  { query: '早呀，今天也来烦你了', expect: [46, 47], note: '打招呼 → 口牙' },
  { query: '你别老像在写周报一样说话', expect: [8, 11, 14], note: '报账腔 → 可爱学妹人设' },
  { query: '以后开口就喊我主人吧', expect: [17, 18, 20], note: '称呼主人 → 鲸鱼女仆娘' },
  { query: '你那个长条横线能不能少用点', expect: [4, 6], note: '破折号 → 语气偏好' },
  { query: '省着点烧，别太费', expect: [3], note: 'token 开销' },
  { query: '你在QQ上别动不动就丢图', expect: [24, 26, 27], note: '表情包选择性发送' },
  { query: '我最近在重温那部打斗番', expect: [31], note: '咒术回战' },
  { query: '那些整活的台词咋念的来着', expect: [37, 38, 39, 45], note: '海虎强者语' },
  { query: '你俩平时怎么互相称呼的', expect: [33], note: '大肥鱼' },
  { query: '每天大清早你在忙什么', expect: [42, 43], note: '放行/放风' },
];

const db = new DatabaseSync(DB, { readOnly: true });
const memories = db.prepare("SELECT id, type, content FROM memories WHERE status = 'active'").all();
console.log(`记忆 ${memories.length} 条，测试 ${CASES.length} 条换说法\n`);

const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', { cache_dir: CACHE, dtype: 'q8' });

async function embed(texts) {
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  return out.tolist();
}

const memVectors = await embed(memories.map((m) => m.content));
const queryVectors = await embed(CASES.map((c) => c.query));

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i];
  return dot;
}

function literalHit(query) {
  // 字面：把整句拆成词做 LIKE（模拟当前 tokenizeQuery 的粗粒度）
  const tokens = query.replace(/[，。？！、\s]+/g, ' ').split(' ').filter((t) => t.length >= 2).map((t) => t.slice(0, 8));
  for (const m of memories) {
    if (tokens.some((t) => m.content.includes(t))) return m.id;
  }
  return null;
}

let literalHits = 0;
let semanticHits = 0;
const rows = [];
for (let i = 0; i < CASES.length; i += 1) {
  const c = CASES[i];
  const scored = memories
    .map((m, j) => ({ id: m.id, score: cosine(queryVectors[i], memVectors[j]), content: m.content }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const lit = literalHit(c.query);
  const litOk = lit !== null && c.expect.includes(lit);
  const semOk = scored.some((s) => c.expect.includes(s.id));
  if (litOk) literalHits += 1;
  if (semOk) semanticHits += 1;
  rows.push({
    q: c.query,
    lit: lit ? `${lit}${litOk ? '✓' : '✗'}` : '—',
    top3: scored.map((s) => `${s.id}(${s.score.toFixed(2)})`).join(' '),
    sem: semOk ? '✓' : '✗',
    note: c.note,
  });
}

for (const r of rows) {
  console.log(`${r.sem} ${r.q}`);
  console.log(`   字面:${r.lit}  语义top3:${r.top3}  ${r.note}`);
}
console.log(`\n字面命中 ${literalHits}/${CASES.length}，语义命中 ${semanticHits}/${CASES.length}`);
