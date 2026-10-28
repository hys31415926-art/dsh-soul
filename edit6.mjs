import fs from 'node:fs';
let t = fs.readFileSync('README.md', 'utf8');
const pairs = [
  ['当前版本 **1.5.0**', '当前版本 **1.5.1**'],
  ['| `1.5.0` | 检索路由',
   '| `1.5.1` | `/soul status` 直接显示语义检索是「已加载 / 懒加载 / 降级（原因）」并给出已建索引条数；`sharp` 声明为显式依赖（修复 `Could not load the "sharp" module` 导致的长期降级） |\n| `1.5.0` | 检索路由'],
];
for (const [from, to] of pairs) {
  if (!t.includes(from)) throw new Error(`anchor missing: ${from.slice(0, 40)}`);
  t = t.replace(from, to);
}
const section = `
## 语义检索装不上时（降级与修复）

向量模型（`bge-small-zh-v1.5`，512 维）是**懒加载**的：装不上就静默退回字面检索，对话不会报错，所以很容易长期不知道自己一直在用字面检索。现在 `/soul status` 会直接显示状态：

\`\`\`
语义检索：开（Xenova/bge-small-zh-v1.5 已加载，已建索引 177 条）
语义检索：开（模型懒加载，尚未触发，已建索引 0 条）
语义检索：降级为字面（Could not load the "sharp" module using the win32-x64 runtime，已建索引 0 条）
\`\`\`

windows 上最常见的原因是 `sharp` 的预编译二进制装坏了（`@img/sharp-win32-x64` 里的 `.node` 加载报 \`ERR_DLOPEN_FAILED: The specified module could not be found\`，模型和 transformers.js 本身都是好的）。修法是重装一份干净的 \`sharp\`：

\`\`\`bash
npm install sharp --no-audit --no-fund        # 在插件目录里跑，会带上匹配平台的 @img/sharp-win32-x64
node -e "require('sharp')"                    # 不报错即修好
\`\`\`

模型文件本身在 \`<dataDir>/models/Xenova/bge-small-zh-v1.5/\`（config.json + tokenizer.json + onnx/model.onnx，约 114MB）。缺文件时会在有网的情况下自动下载。修好后启动 3 秒会自动回填历史记忆的向量索引（\`syncEmbeddings\`），不需要手动重建。
`;
t = `${t.trimEnd()}\n${section}`;
fs.writeFileSync('README.md', t);
console.log('README ok');
