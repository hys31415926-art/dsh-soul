/**
 * style — 本地统计主人怎么说话（句长、表情、口头禅），零模型调用。
 *
 * 和「记忆」分开：这些是统计出来的语气信息，不是事实，所以只出现在注入块的一行里，
 * 不写进长期记忆、也不参与检索。每轮用户消息更新一次，够稳了才输出（n >= 12）。
 */
const META_KEY = 'soul.style';

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const CATCH_RE = /(#\([^)]{1,6}\)|233+|hhh+|草|绝了|离谱|笑死|好家伙|属于是)/gu;

const emptyStyle = () => ({ n: 0, chars: 0, emoji: 0, catchCount: 0, marks: 0, words: {} });

export function loadStyle(store) {
  try {
    const raw = store.metaGet(META_KEY);
    if (!raw) return emptyStyle();
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? { ...emptyStyle(), ...parsed } : emptyStyle();
  } catch {
    return emptyStyle();
  }
}

/** 把一条用户消息并进滚动统计。调用方负责 try/catch，别让统计影响对话。 */
export function recordStyle(store, text) {
  const s = String(text ?? '');
  if (s === '') return;
  const prev = loadStyle(store);
  const chars = [...s].length;
  const emoji = (s.match(EMOJI_RE) ?? []).length;
  const words = { ...(prev.words ?? {}) };
  for (const w of (s.match(CATCH_RE) ?? []).slice(0, 4)) words[w] = (words[w] ?? 0) + 1;
  const next = {
    n: prev.n + 1,
    chars: prev.chars + chars,
    emoji: prev.emoji + emoji,
    catchCount: prev.catchCount + (s.match(CATCH_RE) ?? []).length,
    marks: prev.marks + (/[~～!！…]/u.test(s) ? 1 : 0),
    words,
  };
  store.metaSet(META_KEY, JSON.stringify(next));
}

/** 一句话描述主人的说话习惯；样本不够时返回空串。 */
export function styleSummaryOf(store) {
  try {
    return styleSummary(loadStyle(store));
  } catch {
    return '';
  }
}

export function styleSummary(style) {
  if (!style || style.n < 12) return '';
  const avg = Math.round(style.chars / style.n);
  const bits = [];
  if (avg <= 10) bits.push('句子很短');
  else if (avg <= 22) bits.push('句子偏短');
  else if (avg >= 60) bits.push('习惯写长段');
  else bits.push('长短适中');
  const words = Object.entries(style.words ?? {})
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([w]) => w);
  if (words.length > 0) bits.push('爱用「' + words.join('、') + '」');
  if (style.emoji / style.n >= 0.15) bits.push('常用表情');
  if (style.marks / style.n >= 0.3) bits.push('爱用~和……');
  return bits.join('、');
}
