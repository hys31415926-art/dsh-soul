// 端到端：真实模型 → 写记忆 → 回填向量 → 换种说法检索。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from './lib/memory/store.js';
import { createEmbedder } from './lib/memory/embed.js';
import { syncEmbeddings } from './lib/memory/vecindex.js';
import { selectMemories } from './lib/memory/retrieval.js';

const dir = mkdtempSync(join(tmpdir(), 'soul-embed-e2e-'));
const store = openStore(join(dir, 'soul.db'));
const embedder = createEmbedder({ cacheDir: 'C:/Users/HP/.dsh/dsh-soul/models' });

store.rememberMemory({ type: 'preference', content: '用户怕冷，空调别开太低' });
store.rememberMemory({ type: 'preference', content: '用户喜欢深色主题' });
store.rememberMemory({ type: 'fact', content: '项目在 C:/Users/HP/Desktop/work' });

const t0 = Date.now();
const stats = await syncEmbeddings(store, embedder.embed, { logger: console });
console.log('回填', stats, ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('索引条数 memory =', store.embeddingCount('memory'));

const query = '屋里温度调到二十六度吧';
const [vector] = await embedder.embed([query]);
const result = selectMemories(store, { query, queryVector: vector, limit: 5, budgetChars: 800 });
console.log('query =', query);
console.log('召回:', result.memories.map((m) => m.content));

const query2 = '界面颜色换成暗色的';
const [vector2] = await embedder.embed([query2]);
const result2 = selectMemories(store, { query: query2, queryVector: vector2, limit: 5, budgetChars: 800 });
console.log('query =', query2);
console.log('召回:', result2.memories.map((m) => m.content));

store.close();
rmSync(dir, { recursive: true, force: true });
