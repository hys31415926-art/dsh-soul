/**
 * vecindex — 向量索引回填：把还没算过向量的记忆/对话原话补上。
 *
 * 为什么放后台：模型首次加载要下载+初始化（十几秒），不能卡在对话路径上；
 * 一次只算一小批，避免 CPU 峰值把当前这轮的注入拖慢。
 *
 * 边界：只建索引，不改记忆内容；算不出来就停下（下次启动再试），不影响字面检索。
 */
export async function syncEmbeddings(store, embed, { limit = 24, turnDays = 30, maxMemories = 400, maxTurns = 400, logger, now = Date.now() } = {}) {
  const stats = { memories: 0, turns: 0 };
  if (typeof embed !== 'function') return stats;
  const startedAt = Date.now();

  // 1) 记忆：所有 active 里还没有向量的。
  const memories = store.listMemories({ status: 'active', limit: maxMemories });
  const missingMemories = memories.filter((memory) => !store.getEmbedding('memory', memory.id));
  for (let i = 0; i < missingMemories.length; i += limit) {
    const batch = missingMemories.slice(i, i + limit);
    const vectors = await embed(batch.map((memory) => memory.content));
    if (!vectors) break;
    batch.forEach((memory, j) => {
      if (vectors[j]) {
        store.setEmbedding('memory', memory.id, vectors[j], now);
        stats.memories += 1;
      }
    });
  }

  // 2) 对话原话：近 N 天、用户说过的句子（用于跨会话语义召回）。
  const since = now - Math.max(1, turnDays) * 86_400_000;
  const turns = store.turnsForIndexing({ since, limit: maxTurns });
  const missingTurns = turns.filter((turn) => !store.getEmbedding('turn', turn.id));
  for (let i = 0; i < missingTurns.length; i += limit) {
    const batch = missingTurns.slice(i, i + limit);
    const vectors = await embed(batch.map((turn) => turn.text));
    if (!vectors) break;
    batch.forEach((turn, j) => {
      if (vectors[j]) {
        store.setEmbedding('turn', turn.id, vectors[j], now);
        stats.turns += 1;
      }
    });
  }

  const cost = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (stats.memories + stats.turns > 0) {
    logger?.info?.(`向量索引回填：记忆 ${stats.memories} 条、对话 ${stats.turns} 条（${cost}s）`);
  }
  return stats;
}
