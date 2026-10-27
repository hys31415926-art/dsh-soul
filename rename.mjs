import { readFileSync, writeFileSync, readdirSync, statSync, rmSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = 'C:/Users/HP/Desktop/work/soul-build';
const rules = [
  [/\/companion\b/g, '/soul'],
  [/companion-workflow/g, 'soul-workflow'],
  [/companion_/g, 'soul_'],
  [/companion\.db/g, 'soul.db'],
  [/companion\.log/g, 'soul.log'],
  [/dsh-companion/g, 'dsh-soul'],
  [/companion-/g, 'soul-'],
  [/companion/gi, 'soul'],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|md|json|yml)$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...walk(join(root, 'lib')), ...walk(join(root, 'tests')), ...walk(join(root, 'skills')), join(root, 'README.md')].filter((p) => existsSync(p));
let touched = 0;
for (const file of files) {
  let text = readFileSync(file, 'utf8');
  const before = text;
  for (const [re, to] of rules) text = text.replace(re, to);
  if (text !== before) { writeFileSync(file, text, 'utf8'); touched += 1; }
}
console.log('rewritten files:', touched);

// 删除死代码
rmSync(join(root, 'lib/memory/soul-import.js'), { force: true });
rmSync(join(root, 'tests/soul-import.test.js'), { force: true });
rmSync(join(root, 'docs'), { recursive: true, force: true });
rmSync(join(root, 'scripts'), { recursive: true, force: true });

// 技能目录改名
const oldSkill = join(root, 'skills', 'soul-workflow');
console.log('skill dir exists:', existsSync(oldSkill));
