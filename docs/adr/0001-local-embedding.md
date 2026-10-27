# ADR 0001：语义检索用本地 ONNX 小模型

日期：2026-10-26
状态：已采纳

## 背景

记忆是极短的中文句子（30~60 字），字面召回对同义改写几乎无效——「屋里温度调到二十六度」和「用户怕冷，空调别开太低」字面上没有一个共同的实词。用户明确要求「换一种说法也能想起来」。

## 决定

用 `@huggingface/transformers` 在进程内跑 `Xenova/bge-small-zh-v1.5`（512 维，ONNX），向量存 `soul.db` 的 `embeddings` 表，检索时与字面命中合并排序。

## 理由

- 不依赖任何 API、不加密钥、断网可用（模型缓存到 `<DSH_HOME>/dsh-soul/models` 后离线）。
- 单条 30-60 字，CPU 编码 < 100ms；懒加载 + 后台回填，不拖慢挂载。
- 失败可降级：模型装不上就把 `embeddingRetrieval` 当 false，字面检索照旧，不报错。

## 代价

- 包体积 +145MB（`onnxruntime-node` + `transformers`），已删非 Windows 二进制。
- 换模型要重建向量索引（维度绑定在表里）。
- 首次下载模型需要一次联网（HuggingFace 直连；国内可走镜像）。
