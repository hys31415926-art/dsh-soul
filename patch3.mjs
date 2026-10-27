import { readFileSync, writeFileSync } from 'node:fs';

const p = 'C:/Users/HP/Desktop/work/soul-build/tests/tools.test.js';
let s = readFileSync(p, 'utf8');

s = s.replace(
  "test('注册：8 个工具全部注册，且卸载后清空', (t) => {",
  "test('注册：11 个工具全部注册，且卸载后清空', (t) => {",
);
s = s.replace(
  `  assert.deepEqual(names, [
    'soul_forget', 'soul_projects', 'soul_remember', 'soul_review',
    'soul_search', 'soul_session', 'soul_status', 'soul_task',
  ]);`,
  `  assert.deepEqual(names, [
    'soul_episodes', 'soul_forget', 'soul_learn', 'soul_projects', 'soul_remember',
    'soul_review', 'soul_search', 'soul_self', 'soul_session', 'soul_status', 'soul_task',
  ]);`,
);

const extra = `
test('soul_learn / soul_self / soul_episodes 闭环', async (t) => {
  const { exec, store } = setup(t);
  const learned = await exec('soul_learn', { title: '部署 dsh-soul', body: '复制到 profile node_modules 后重启宿主' });
  assert.match(learned.text, /沉淀 #\\d+/);
  const found = await exec('soul_search', { query: '部署' });
  assert.equal(found.count, 1);

  const self = await exec('soul_self', { text: '我是后辈搭子，先给结论' });
  assert.match(self.text, /自我认知已更新/);
  assert.equal(store.metaGet('soul.selfModel'), '我是后辈搭子，先给结论');

  const episodes = await exec('soul_episodes', { limit: 5 });
  assert.equal(episodes.count, 0);
  assert.match(episodes.text, /还没有记录/);
});
`;

if (!s.includes('soul_learn / soul_self / soul_episodes 闭环')) s = s.trimEnd() + '\n' + extra;

writeFileSync(p, s, 'utf8');
console.log('tools.test.js updated');
