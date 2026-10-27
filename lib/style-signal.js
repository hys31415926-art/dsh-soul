/**
 * 语体信号识别（v2 学习闭环的第一环）。
 *
 * 为什么需要它：插件原来只从对话里抽「事实」，没有任何地方记「我怎么说话」。
 * 于是「学说话」只能退化成把规则写进人设——那是钉住，不是学。
 *
 * 这里只做一件事：从主人这一句里判断他是在夸上一句的说话方式、还是在嫌，
 * 判不出来就返回 null，不猜。判出来之后由调用方把「上一轮的原话」存进样本库。
 */

const PRAISE_RE = new RegExp(
  [
    '(?:这|那)(?:句|样|个说法|句话).{0,6}(?:好|对|行|舒服|自然|好听|可爱|喜欢|可以)',
    '这么(?:说|讲|写).{0,6}(?:好|对|行|舒服|自然|好听|可以)',
    '这样(?:说|讲|写).{0,6}(?:好|对|行|舒服|自然|好听|可以)',
    '就这样(?:说|讲|写|聊)',
    '(?:说得|讲得|写得)(?:好|不错|对|自然)',
    '(?:这|那)就对了',
    '有(?:内味|那味|味道)',
    '(?<![不别])像你(?:了|本人|自己)',
    '(?:很|挺|蛮)(?:自然|好听|可爱|像你)',
  ].join('|'),
  'u',
);

const CORRECTION_RE = new RegExp(
  [
    '(?:像|成|又是|怎么又|变回).{0,4}(?:说明书|客服|电报|机器人|模板|公文|AI)',
    '别(?:再)?这么(?:说|讲|写|讲话)',
    '(?:太|有点|又)(?:生硬|机械|官方|端着|僵|套话)',
    '不像你(?:了)?',
    '怎么(?:又)?(?:变|像)了',
    '冷冰冰|没人味|没内味',
  ].join('|'),
  'u',
);

/** 一句话最长按多少字判断（再长基本是在说正事，不是评价说话方式）。 */
const MAX_SIGNAL_CHARS = 40;

/**
 * @param {string} text 主人这一轮说的话
 * @returns {'praise'|'correction'|null}
 */
export function classifyFeedbackSignal(text) {
  const t = String(text ?? '').trim();
  if (t === '' || t.length > MAX_SIGNAL_CHARS) return null;
  // 「这句好，但是……」是夸完接着提要求，混着两种意思，不当成干净的语体信号。
  if (/(?:但是|不过|可是|然而)/u.test(t)) return null;
  if (PRAISE_RE.test(t)) return 'praise';
  if (CORRECTION_RE.test(t)) return 'correction';
  return null;
}

/**
 * 从一段回复里挑一句「能当样本」的话：够完整、不带头、不是代码/清单/表格。
 * 返回''表示这段回复没有可复用的语体样本。
 */
export function pickReplySentence(reply, { maxChars = 120 } = {}) {
  const lines = String(reply ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  let best = '';
  for (const line of lines) {
    // 清单、标题、代码、表格、引用不算说话方式
    const head = line[0];
    if ('-*+·>#|['.includes(head)) continue;
    if (/^\d+[.、)]/u.test(line)) continue;
    if (line.startsWith('```') || line.includes('`')) continue;
    if (/[{}<>]/.test(line) || /\|.*\|/.test(line)) continue;
    // 按句拆，取这一行里最长的完整句子
    const sentences = line.split(/(?<=[。！？!?~～])/u).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences.length > 0 ? sentences : [line]) {
      const plain = sentence.replace(/[*_`]/g, '').trim();
      if (plain.length < 12 || plain.length > maxChars) continue;
      if (plain.length > best.length) best = plain;
    }
  }
  return best;
}
