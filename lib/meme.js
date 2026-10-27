/**
 * meme — 本地梗库查询（cnmeme.wiki 公开词条的只读快照）。
 *
 * 为什么不并进 soul.db：
 *   · 梗是公共知识，不是「我们之间的事」——塞进记忆库会污染检索、稀释每轮注入；
 *   · 词条体量（6660 条 / 约 16MB）远大于记忆库，更新节奏也不同；
 *   · 记忆库要小、要能被每轮检索；梗库只在「像在问梗」的时候查。
 *
 * 数据放 <DSH_HOME>/dsh-soul/memes.db，只读打开。库缺失时插件照常工作，
 * 工具回一句「没有梗库」，不抛错、不阻塞对话。
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { clip } from './util.js';

/** 裸词不查的黑名单：问候、应答、常见短句。这些词不可能是梗查询。 */
const STOP_WORDS = new Set([
  '在吗', '在不在', '哈哈', '哈哈哈', '笑死', '好的', '好吧', '晚安', '早安',
  '睡觉', '吃饭', '干嘛', '没事', '收到', '谢谢', '好耶', '草', '典', '乐',
  '嗯', '哦', '好', '行', '对', '是', '可以', '还行', '不错', '确实', '真的',
  '没有', '不是', '就是', '知道', '明白', '来了', '走了', '好家伙',
]);

/** 唤醒词：出现在句首时剥掉，避免「大肥鱼这梗什么意思」把昵称当词条。 */
const WAKE_WORDS = ['大肥鱼', '小肥鱼', '大鲸鱼', '小鲸鱼', '鲸鱼', 'deepseek', 'ds'];

/** 「X 是什么梗」类问句。 */
const ASK_PATTERN = /(?:是什么梗|什么梗|啥梗|什么意思|啥意思|怎么来的|什么来历|出处在哪|哪里来的)/u;

/** 裸词：2-10 个中英数字，对应「群里刷了一个词」的场景。 */
const BARE_PATTERN = /^[\u4e00-\u9fa5A-Za-z0-9·]{2,10}$/u;

/** 指代词：单独出现时无法确定在问哪个梗。 */
const PRONOUNS = new Set([
  '这', '那', '它', '他', '她', '这个', '那个', '你', '我',
  '这句话', '那句话', '上面', '刚才', '下文', '前面', '这个梗', '那个梗',
]);

/**
 * 打开梗库（只读）。返回 null 表示「没有库」，调用方照常工作。
 * @param {string} dbPath
 * @param {{warn?: (msg: string) => void}} [logger]
 * @returns {DatabaseSync | null}
 */
export function openMemeDb(dbPath, logger) {
  if (!dbPath || !existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    logger?.warn?.(`meme: 打开梗库失败 (${dbPath}): ${err?.message ?? err}`);
    return null;
  }
}

/** @param {any} row */
function rowToMeme(row) {
  return {
    title: String(row.title ?? ''),
    slug: String(row.slug ?? ''),
    tags: String(row.tags ?? ''),
    usage: String(row.usage ?? ''),
    origin: String(row.origin ?? ''),
    other: String(row.other ?? ''),
  };
}

/**
 * 查梗。三档：精确标题 → 标题被查询词包含（长标题优先）→ LIKE 兜底。
 * strict 模式只走前两档（对应「自动预查」：宁可漏，不能把普通短句当梗）。
 * @param {DatabaseSync | null} db
 * @param {string} raw
 * @param {{strict?: boolean}} [opts]
 */
export function lookupMeme(db, raw, { strict = false } = {}) {
  if (!db) return null;
  const q = String(raw ?? '').trim();
  if (!q) return null;
  const exact = db.prepare('SELECT * FROM memes WHERE title = ? LIMIT 1').get(q);
  if (exact) return rowToMeme(exact);
  const contained = db
    .prepare('SELECT * FROM memes WHERE title <> ? AND length(title) >= 2 AND instr(?, title) > 0 ORDER BY length(title) DESC LIMIT 1')
    .get(q, q);
  if (contained) return rowToMeme(contained);
  if (strict) return null;
  const fuzzy = db
    .prepare('SELECT * FROM memes WHERE title LIKE ? OR slug LIKE ? ORDER BY length(title) ASC LIMIT 1')
    .get(`%${q}%`, `%${q}%`);
  return fuzzy ? rowToMeme(fuzzy) : null;
}

/**
 * 给模型看的排版：怎么用/怎么接在前，出处只标「仅用于理解，别照搬」。
 * 顺序是有意的——先给用法，模型才可能直接接梗而不是先科普。
 * @param {ReturnType<typeof rowToMeme>} meme
 */
export function formatMeme(meme) {
  const lines = [`【梗】${meme.title}`];
  if (meme.tags) lines.push(`标签：${clip(meme.tags, 120)}`);
  if (meme.usage) {
    lines.push(`【怎么用 / 怎么接】\n${clip(meme.usage, 600)}`);
  }
  if (meme.origin) {
    lines.push(`【出处（仅用于理解，别照搬）】\n${clip(meme.origin, 450)}`);
  }
  if (meme.other) lines.push(clip(meme.other, 300));
  lines.push(`来源：cnmeme.wiki/词条/${meme.slug}`);
  return lines.join('\n');
}

/**
 * 短版（给注入块用）：只留「这个词 + 怎么接」。
 * @param {ReturnType<typeof rowToMeme>} meme
 */
export function formatMemeBrief(meme) {
  return `「${meme.title}」：${clip(meme.usage || meme.origin, 160)}`;
}

/** 去掉开头的 @ 和唤醒词，剥掉首尾标点。 */
export function cleanMemeText(text) {
  let t = String(text ?? '').trim();
  t = t.replace(/^(@\S+\s*)+/u, '');
  for (const w of WAKE_WORDS) {
    if (t.startsWith(w)) {
      t = t.slice(w.length).trim().replace(/^[，,。.！!？?:：\s]+/u, '');
      break;
    }
  }
  return t.trim();
}

/**
 * 判断一句话是不是在问梗；是则返回查询词，否则 null。
 * 只认两类：明确的问句（「X 是什么梗」），以及 2-10 字的裸词。
 * @param {string} text
 */
export function extractMemeQuery(text) {
  const t = cleanMemeText(text);
  if (!t) return null;
  const m = ASK_PATTERN.exec(t);
  if (m) {
    let head = t.slice(0, m.index).trim().replace(/[，,。.！!？?:：\s]+$/u, '');
    head = head.replace(/^(这个梗|那个梗|这梗|那梗|这个|那个)/u, '').trim();
    head = head.replace(/(到底|究竟)$/u, '').trim();
    if (!head || PRONOUNS.has(head)) return null;
    if (head.length <= 1 || head.length > 12) return null;
    return head;
  }
  if (BARE_PATTERN.test(t) && !STOP_WORDS.has(t)) return t;
  return null;
}
