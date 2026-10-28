/**
 * attributes — 记忆里的「属性槽」。
 *
 * 有些属性是一个人身上的**单值槽**：住址、职业、公司、生日……同一时刻只能有一个值。
 * 这类属性改口时，旧值不该被删掉，而该被标成 superseded 指回新值 ——「你以前住哪」
 * 还答得出来，「你现在住哪」只看得到新值。
 *
 * 另一些是**多值**：习惯、喜好、约定……它们可以并存，绝不互相取代。
 * 「喜欢喝美式」和「最近在戒咖啡」不是矛盾，是变化。
 *
 * 纯函数，不读写数据库，便于单元测试。
 */

/** 单值属性槽：[槽名, 识别正则]。顺序有意义，先匹配更具体的。 */
const SINGLE_VALUE_SLOTS = [
  ['住址', /(住在|家住|地址|搬家|搬到|小区|租房|合租|宿舍|哪个城市|哪个区)/u],
  ['职业', /(职业|工作是|做什么工作|在哪工作|职位|跳槽|转行|离职|入职|实习)/u],
  ['公司', /(公司|单位|上班的地方)/u],
  ['学校', /(学校|大学|读研|念书|专业是|在哪读)/u],
  ['生日', /(生日|出生|几岁|年龄|多大岁数|本命年)/u],
  ['手机', /(手机号|电话是|号码是|换号|换了手机)/u],
  ['邮箱', /(邮箱|邮件地址|e-?mail)/iu],
  ['身体', /(身高|体重|多高|多重)/u],
  ['家乡', /(老家|家乡|籍贯)/u],
  ['星座', /(星座)/u],
];

/** 多值信号：出现这些说法一律按「可以并存」处理，不做取代。 */
const MULTI_VALUE_RE = /(习惯|常常|经常|有时候|偶尔|喜欢|讨厌|受不了|偏好|爱吃|爱吃|不爱|约定|每天|每周|一般会|通常会|最近在|正在戒|打算|计划|也可以)/u;

/** 这些类型本身不是「单值属性」，不参与改口取代。 */
const NON_SLOT_TYPES = new Set(['preference', 'interaction', 'relationship', 'episodic', 'project']);

/**
 * 这条记忆落在哪个单值属性槽上；不是单值属性就返回 null。
 * @param {string} content
 * @param {string} [type]
 * @returns {string|null}
 */
export function attributeSlot(content, type = '') {
  const text = String(content ?? '');
  if (text.trim() === '') return null;
  if (NON_SLOT_TYPES.has(String(type ?? ''))) return null;
  if (MULTI_VALUE_RE.test(text)) return null;
  for (const [slot, pattern] of SINGLE_VALUE_SLOTS) {
    if (pattern.test(text)) return slot;
  }
  return null;
}

/** 是否是单值属性（会改口的那一类）。 */
export function isSingleValue(content, type = '') {
  return attributeSlot(content, type) !== null;
}

/**
 * 旧值该不该被新值取代。
 * 保守起见：低置信度的推断不能推翻用户明确说过的话。
 * @returns {boolean}
 */
export function shouldSupersede(previous, next) {
  if (!previous || !next) return false;
  if (Number(previous.id) === Number(next.id)) return false;
  if (String(previous.status ?? 'active') !== 'active') return false;
  if (String(previous.content ?? '') === String(next.content ?? '')) return false;
  const prevExplicit = String(previous.source ?? '') === 'user-explicit';
  const nextExplicit = String(next.source ?? '') === 'user-explicit';
  if (prevExplicit && !nextExplicit) {
    if (Number(next.confidence ?? 0.6) < Number(previous.confidence ?? 0.6)) return false;
  }
  return true;
}
