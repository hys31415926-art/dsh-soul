// 验证：本地向量模型能否加载、中文近义句相似度是否分得开。
import { env, pipeline } from '@huggingface/transformers';

env.cacheDir = 'C:/Users/HP/.dsh/dsh-soul/models';
env.allowLocalModels = true;

const t0 = Date.now();
const extractor = await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5');
console.log('loaded in', ((Date.now() - t0) / 1000).toFixed(1), 's');

const sentences = [
  '我房间的空调别开太低',
  '空调温度调低一点比较好',
  '这个项目用 TypeScript 写',
  '今天天气不错',
];
const out = await extractor(sentences, { pooling: 'mean', normalize: true });
const dim = out.dims.at(-1);
const vecs = [];
for (let i = 0; i < sentences.length; i += 1) vecs.push(Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
function cos(a, b) { let d = 0; for (let i = 0; i < a.length; i += 1) d += a[i] * b[i]; return d; }
console.log('dim =', dim);
for (let i = 0; i < sentences.length; i += 1) {
  for (let j = i + 1; j < sentences.length; j += 1) {
    console.log(`${cos(vecs[i], vecs[j]).toFixed(3)}  ${sentences[i]}  |  ${sentences[j]}`);
  }
}
