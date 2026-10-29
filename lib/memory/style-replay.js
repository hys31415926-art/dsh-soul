/**
 * 历史语体回放（v3.1）。
 *
 * 实时钩子只能处理「这一轮刚发生」的反馈；如果插件重启、消息漏接，
 * 那些批评与自采纳就永远停在 turns 里。这个模块按回合顺序重放 user_text
 * 里的反馈与 assistant_text 里的自评，让它们补记成规则/样本。
 *
 * 原则与实时链路一致：
 *   · 用户批评只沉淀正向规则，不把用户原话写成记忆；
 *   · 负评只扣「文字高度重合」或「上一回合确实注入过」的正样本；
 *   · 助手自采纳/自认错只提候选规则，不给自己发正向或负向证据；
 *   · 同一 turnId 幂等，重复回放不重复计证据、不重复扣分。
 */
import { classifyTurn } from '../core/conversation-policy.js';
import { sceneOf as sceneOfKind } from '../core/scene.js';
import { analyzeFeedbackSignal, pickReplySentence } from '../style-signal.js';
import { buildForbiddenRules } from '../output-guard.js';
import {
  addStyleExample,
  listStyleExamples,
  normalizeStyleText,
  penalizeStyleExamples,
} from './style-examples.js';

const ADOPT_RE = /(?:这说法|这个说法|这句|这股劲|这个味).{0,8}(?:我要了|记下了|学到了|收着)|往后照着来|以后就这么说/u;
const SELF_BLAME_RE = /拉了就是拉了|确实(?:拉了|垮了|端着了|生硬了)|不狡辩|刚才那句(?:确实|有点)垮/u;

function sceneOf(userText) {
  return sceneOfKind(classifyTurn(String(userText ?? '')).kind);
}

function hasSample(store, text) {
  const norm = normalizeStyleText(text);
  if (norm === '') return true;
  return listStyleExamples(store, { limit: 500 }).some((row) => normalizeStyleText(row.text) === norm);
}

/**
 * @param {object} store
 * @param {{sessionId?:string, limit?:number, since?:number, config?:object, logger?:object}} options
 */
export function replayStyleFromTurns(store, {
  sessionId = '',
  limit = 50,
  since = 0,
  config = {},
  logger = null,
} = {}) {
  const db = store?.db;
  if (!db) return { turns: 0, praise: 0, corrections: 0, preferences: 0, rules: 0, samples: 0, penalties: 0, skipped: 0 };
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  let rows = [];
  try {
    rows = sessionId
      ? db.prepare('SELECT * FROM turns WHERE session_id = ? AND ended_at >= ? ORDER BY id ASC').all(String(sessionId), Number(since) || 0)
      : db.prepare('SELECT * FROM turns WHERE ended_at >= ? ORDER BY id ASC').all(Number(since) || 0);
  } catch {
    return { turns: 0, praise: 0, corrections: 0, preferences: 0, rules: 0, samples: 0, penalties: 0, skipped: 0 };
  }
  rows = rows.slice(-cap);
  const rules = buildForbiddenRules(config?.forbiddenPatterns ?? []);
  const out = { turns: rows.length, praise: 0, corrections: 0, preferences: 0, rules: 0, samples: 0, penalties: 0, skipped: 0 };

  const applyUserFeedback = (turn, previous) => {
    const feedback = analyzeFeedbackSignal(String(turn.user_text ?? ''));
    if (!feedback || !previous) return false;
    const scene = sceneOf(turn.user_text);
    const previousTurnId = Number(previous.id ?? 0);
    if (feedback.signal === 'praise') {
      const sentence = pickReplySentence(String(previous.assistant_text ?? ''), { maxChars: 120 });
      if (sentence === '' || hasSample(store, sentence)) {
        out.skipped += 1;
        return true;
      }
      const saved = addStyleExample(store, {
        text: sentence,
        kind: 'positive',
        scene,
        source: 'replay-praise',
        rules,
      });
      if (saved) out.samples += 1;
      out.praise += 1;
      return true;
    }
    if (feedback.signal === 'preference') {
      const rule = store.upsertBehaviorRule({
        rule: feedback.rule,
        scene,
        category: feedback.category,
        isExplicit: feedback.explicit,
        turnId: previousTurnId,
        weight: feedback.strength,
        source: feedback.explicit ? 'replay-user-explicit' : 'replay-user-preference',
      });
      if (rule) out.rules += 1;
      out.preferences += 1;
      return true;
    }
    const rule = store.upsertBehaviorRule({
      rule: feedback.rule,
      scene,
      category: feedback.category,
      isExplicit: feedback.explicit,
      turnId: previousTurnId,
      weight: feedback.strength,
      source: feedback.explicit ? 'replay-user-explicit' : 'replay-user-feedback',
    });
    if (rule) out.rules += 1;
    out.corrections += 1;
    const sentence = pickReplySentence(String(previous.assistant_text ?? ''), { maxChars: 160 });
    if (sentence !== '' && !hasSample(store, sentence)) {
      const negative = addStyleExample(store, {
        text: sentence,
        kind: 'negative',
        scene,
        source: 'replay-criticism',
        score: 0.3,
        rules,
      });
      if (negative) out.samples += 1;
    }
    if (sentence !== '') {
      const injectedSince = Number(previous.started_at ?? 0) > 0
        ? Number(previous.started_at) - 2 * 60_000
        : 0;
      const penalized = penalizeStyleExamples(store, {
        text: sentence,
        scene,
        turnId: previousTurnId,
        injectedSince,
        logger,
      });
      out.penalties += penalized.length;
      if (penalized.length === 0) logger?.debug?.('回放：负评未命中可归责样本，不扣分');
    }
    return true;
  };

  const applySelfFeedback = (turn) => {
    const text = String(turn.assistant_text ?? '');
    const turnId = Number(turn.id ?? 0);
    if (ADOPT_RE.test(text)) {
      const userLine = pickReplySentence(String(turn.user_text ?? ''), { maxChars: 160 });
      if (userLine !== '' && !hasSample(store, userLine)) {
        const sample = addStyleExample(store, {
          text: userLine,
          kind: 'borrowed',
          scene: sceneOf(turn.user_text),
          source: 'replay-self-adopt',
          score: 0.5,
          rules,
        });
        if (sample) out.samples += 1;
      }
      const rule = store.upsertBehaviorRule({
        rule: '沿用前辈认可的说法与劲头，不改成公文腔或空洞金句',
        scene: sceneOf(turn.user_text),
        category: 'adopted_phrase',
        isExplicit: false,
        turnId,
        weight: 1,
        source: 'replay-self-adopt',
        candidateOnly: true,
      });
      if (rule) out.rules += 1;
      return true;
    }
    if (SELF_BLAME_RE.test(text)) {
      const rule = store.upsertBehaviorRule({
        rule: '直白自然接话，不端架子、不套公文腔与空洞金句',
        scene: sceneOf(turn.user_text),
        category: 'flat_tone',
        isExplicit: false,
        turnId,
        weight: 1,
        source: 'replay-self-blame',
        candidateOnly: true,
      });
      if (rule) out.rules += 1;
      return true;
    }
    return false;
  };

  let previous = null;
  for (const turn of rows) {
    const handledByUser = applyUserFeedback(turn, previous);
    if (!handledByUser) applySelfFeedback(turn);
    previous = turn;
  }
  return out;
}
