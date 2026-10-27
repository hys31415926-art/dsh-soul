import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const root = 'C:/Users/HP/Desktop/work/soul-build';
const rw = (p, fn) => {
  const full = `${root}/${p}`;
  if (!existsSync(full)) return;
  const before = readFileSync(full, 'utf8');
  const after = fn(before);
  if (after !== before) { writeFileSync(full, after, 'utf8'); console.log('fixed', p); }
  else console.log('unchanged', p);
};

rw('tests/hooks.test.js', (s) => s.replace('/背景资料/', '/我记着的/'));

rw('tests/retrieval-render.test.js', (s) => s.replace('assert.match(text, /背景资料/);', 'assert.match(text, /我记着的/);'));

rw('tests/personality-style.test.js', (s) => {
  let out = s;
  out = out.replace(
    "    sessionCount: () => 2,",
    "    sessionCount: () => 2,\n    metaGet: () => '',\n    metaSet: () => {},",
  );
  out = out.replace("  assert.ok(text.includes('背景资料'));", "  assert.ok(text.includes('我记着的'));");
  out = out.replace(
    /test\('提示词写进了行为约束[\s\S]*?\n\}\);\n$/,
    [
      "test('提示词写进了行为约束，且没有把用户的例子变成「禁词表」', () => {",
      "  const policy = readPrompt('interaction-policy.md');",
      "  assert.ok(policy.includes('不套固定回复结构'));",
      "  assert.ok(policy.includes('被评价'));",
      "  assert.ok(policy.includes('不进入自我复盘模式'));",
      "  assert.ok(policy.includes('不承诺空话'));",
      "  assert.ok(!policy.includes('「行 / 认 / 陪 / 收到」'));",
      "",
      "  const persona = readPrompt('persona.md');",
      "  assert.ok(persona.includes('不进入自我复盘模式'));",
      "  assert.ok(persona.includes('不主动升级关系'));",
      "",
      "  const memoryPolicy = readPrompt('memory-policy.md');",
      "  assert.ok(memoryPolicy.includes('工程要求'));",
      "});",
      "",
    ].join('\n'),
  );
  return out;
});
