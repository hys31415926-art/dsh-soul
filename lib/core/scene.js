/**
 * 场景格：只决定「去哪一格里找样本和规则」，不决定说什么。
 *
 * 以前只有 work / chat 两档，亲近、被调侃、被要求检验、情绪低落全塞进 chat。
 * 结果是 chat 格里堆着六类互相冲突的规则，注入时一起出现，读起来像被几股力气同时拽。
 * 这里只把格子分细：写入按细分标签存；读取时新格没有样本就退回 chat（旧数据全在 chat 和 work 里）。
 */

/** 合法的场景标签。写库时不在这个集合里的值会被归到 chat。 */
export const SCENES = ['work', 'chat', 'intimate', 'emotional', 'test', 'feedback'];

const BY_KIND = {
  work: 'work',
  discussion: 'work',
  resume: 'work',
  flirt: 'intimate',
  emotional: 'emotional',
  test: 'test',
  feedback: 'feedback',
  casual: 'chat',
  chat: 'chat',
  'memory-ask': 'chat',
  unknown: 'chat',
};

/** 把对话意图映射成一个场景格。没法判断时落 chat。 */
export function sceneOf(kind) {
  return BY_KIND[String(kind ?? '')] ?? 'chat';
}

/**
 * 读取时要一并接受的兜底格。
 * 细分的格子（亲近/情绪/被检验/反馈）在旧库里一条样本都没有，不兜底就等于把已有的学过的样本全丢了。
 */
export function sceneFallbacks(scene) {
  const s = String(scene ?? 'chat');
  if (s === 'chat' || s === 'work') return [];
  return ['chat'];
}
