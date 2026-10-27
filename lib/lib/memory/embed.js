/**
 * embed — 本地向量：句子 → 归一化向量（bge-small-zh-v1.5，ONNX / transformers.js）。
 *
 * 存在的理由：字面检索只能命中「字一样」的记忆。用户今天说「空调别开太低」，
 * 明天说「屋里别太冷」，字面 LIKE 一条都搜不到，但那说的是同一件事。
 *
 * 三条边界：
 *   · 懒加载：插件启动不等模型，第一次真正需要检索时才加载；
 *   · 失败即降级：模型下不动/加载失败就返回 null，调用方退回字面检索，绝不让对话报错；
 *   · 只做证据：向量分数只是候选排序的一部分，最终用不用仍由阈值和置信度决定。
 */
const DEFAULT_MODEL = 'Xenova/bge-small-zh-v1.5';

/**
 * @param {{model?: string, cacheDir?: string, logger?: any}} options
 * @returns {{ state: {ready: boolean, failed: string|null, model: string}, embed: (texts: string[]|string) => Promise<Float32Array[]|null> }}
 */
export function createEmbedder({ model = DEFAULT_MODEL, cacheDir = '', logger } = {}) {
  let pipelinePromise = null;
  let disabled = false;
  const state = { ready: false, failed: null, model };

  async function getExtractor() {
    if (pipelinePromise === null) {
      pipelinePromise = (async () => {
        const { env, pipeline } = await import('@huggingface/transformers');
        if (cacheDir) env.cacheDir = cacheDir;
        env.allowLocalModels = true;
        const extractor = await pipeline('feature-extraction', model);
        state.ready = true;
        logger?.info?.(`向量模型已加载：${model}`);
        return extractor;
      })().catch((error) => {
        disabled = true;
        state.failed = String(error?.message ?? error);
        logger?.warn?.(`向量模型不可用，语义检索降级为字面检索：${state.failed}`);
        return null;
      });
    }
    return pipelinePromise;
  }

  async function embed(texts) {
    if (disabled) return null;
    const list = (Array.isArray(texts) ? texts : [texts])
      .map((text) => String(text ?? '').trim())
      .filter((text) => text !== '');
    if (list.length === 0) return [];
    const extractor = await getExtractor();
    if (!extractor) return null;
    try {
      const output = await extractor(list, { pooling: 'mean', normalize: true });
      const dim = Number(output.dims?.at(-1) ?? 0);
      if (!dim) return null;
      const vectors = [];
      for (let i = 0; i < list.length; i += 1) {
        vectors.push(Float32Array.from(output.data.slice(i * dim, (i + 1) * dim)));
      }
      return vectors;
    } catch (error) {
      logger?.warn?.(`向量计算失败，本轮退回字面检索：${error?.message ?? error}`);
      return null;
    }
  }

  return { state, embed };
}

/** 两个已归一化向量的余弦相似度（没归一化也能用，除以模长）。 */
export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Float32Array → SQLite BLOB。 */
export function vectorToBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** SQLite BLOB → Float32Array。 */
export function blobToVector(blob) {
  if (!blob) return null;
  const buffer = Buffer.from(blob);
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}
