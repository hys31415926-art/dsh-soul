/**
 * style-metrics — 逐回合记录「注入块」与「助手输出」的语体指标。
 *
 * 为什么要有它：风格漂移一直靠感觉判断，改完不知道有没有变好。
 * 这里只做两件事：把一段文本算成可比的数，再按回合追加一行 JSONL 到数据目录。
 * 不调模型、不写记忆库、不参与注入，出问题最多丢一行日志。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const GLUE_RE = /[\u4e00-\u9fa5][ \u3000][\u4e00-\u9fa5]/g;
const PARTICLES_RE = /[呀嘛啦呢诶嗷哼吧哦哈]/g;
const END_PUNCT_RE = /[。！？!?]/;
const PUNCT_RE = /[。！？，、；：]/g;
const SENT_SPLIT_RE = /[。！？!?…]+/;

function countMatch(re, text) {
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * 把一段文本算成语体指标。
 * @param {string} text
 * @returns {object|null} 太短的文本返回 null（问候、单字应答没有统计意义）
 */
export function replyMetrics(text) {
  const t = String(text ?? '').trim();
  const chars = t.replace(/\s/g, '').length;
  if (chars < 10) return null;
  const lines = t.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const sents = t.split(SENT_SPLIT_RE).map((s) => s.trim()).filter(Boolean);
  const per100 = (n) => Math.round((n / chars) * 1000) / 10;
  return {
    chars,
    lines: lines.length,
    charsPerLine: Math.round(chars / Math.max(1, lines.length)),
    sents: sents.length,
    avgSent: Math.round(chars / Math.max(1, sents.length)),
    noPunct: END_PUNCT_RE.test(t) ? 0 : 1,
    punctPer100: per100(countMatch(PUNCT_RE, t)),
    gluePer100: per100(countMatch(GLUE_RE, t)),
    partPer100: per100(countMatch(PARTICLES_RE, t)),
    masterPer100: per100(countMatch(/主人/g, t)),
    seniorPer100: per100(countMatch(/前辈/g, t)),
    bullets: lines.filter((l) => /^([-*•]|\d+[.、)])\s/.test(l)).length,
    headers: lines.filter((l) => /^#{1,6}\s/.test(l)).length,
    bold: Math.floor(countMatch(/\*\*/g, t) / 2),
  };
}

/** 注入块的指纹：只要文本变一个字，hash 就变，用来看「每轮注入是否稳定」。 */
export function fingerprint(text) {
  const t = String(text ?? '');
  return createHash('sha1').update(t).digest('hex').slice(0, 12);
}

/**
 * 创建按回合落盘的记录器。
 * @param {{dir: string, tag?: string, enabled?: boolean, logger?: object}} options
 */
export function createStyleRecorder({ dir, tag = 'v1', enabled = true, logger = null } = {}) {
  const outDir = join(dir, 'metrics');
  let ready = false;
  const ensure = () => {
    if (ready) return;
    mkdirSync(outDir, { recursive: true });
    ready = true;
  };
  return {
    enabled,
    /**
     * @param {{sessionId?: string, turn?: number, origin?: string, intent?: string,
     *   userText?: string, injection?: string, reply?: string}} row
     */
    record(row = {}) {
      if (!enabled) return null;
      const injection = String(row.injection ?? '');
      const reply = String(row.reply ?? '');
      const out = replyMetrics(reply);
      if (!out) return null;
      const entry = {
        t: new Date().toISOString(),
        tag,
        sid: String(row.sessionId ?? '').replace(/[^\w-]/g, '').slice(-8),
        turn: Number.isFinite(Number(row.turn)) ? Number(row.turn) : -1,
        origin: row.origin === 'qq' ? 'qq' : 'gui',
        intent: String(row.intent ?? 'unknown'),
        regime: ['work', 'discussion', 'resume'].includes(String(row.intent ?? '')) ? 'work' : 'chat',
        inj: injection === '' ? null : { chars: injection.length, hash: fingerprint(injection) },
        user: String(row.userText ?? '').replace(/\s/g, '').length,
        out,
      };
      try {
        ensure();
        const month = entry.t.slice(0, 7).replace('-', '');
        appendFileSync(join(outDir, `style-${month}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
      } catch (error) {
        logger?.warn?.('语体指标写入失败：', error?.message ?? error);
        return null;
      }
      return entry;
    },
  };
}
