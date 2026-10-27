// 部署 soul v1.2.0（含本地向量依赖）到插件目录 + 4 个 profile。
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const SRC = 'C:/Users/HP/Desktop/work/soul-build';
const TARGETS = [
  'C:/Users/HP/dsh-plugins/dsh-soul',
  'C:/Users/HP/.dsh/profiles/desktop/node_modules/dsh-soul',
  'C:/Users/HP/.dsh/profiles/dsh-tui/node_modules/dsh-soul',
  'C:/Users/HP/.dsh/profiles/headless/node_modules/dsh-soul',
  'C:/Users/HP/.dsh/profiles/web/node_modules/dsh-soul',
];
// 构建/调试脚本不进部署目录
const SKIP = new Set([
  'embed-smoke.mjs', 'embed-e2e.mjs', 'rename.mjs', 'gen.mjs', 'patch.mjs',
  'patch2.mjs', 'patch3.mjs', 'patch4.mjs', 'fix-tests.mjs', 'install.ps1',
  'deploy-v120.mjs', 'qt-test.mjs', '.git',
]);
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backupRoot = `C:/Users/HP/Desktop/work/old-plugins-backup/before-vec-${stamp}`;
mkdirSync(backupRoot, { recursive: true });

function retry(fn, tries = 8) {
  let lastError = null;
  for (let i = 0; i < tries; i += 1) {
    try {
      return fn();
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400 * (i + 1));
    }
  }
  throw lastError;
}

function copy(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    force: true,
    filter: (from) => {
      const name = from.split(/[\\/]/).pop();
      return !SKIP.has(name);
    },
  });
}

const results = [];
for (const [index, target] of TARGETS.entries()) {
  const label = String(index + 1) + '-' + target.split(/[\\/]/).slice(-2).join('-');
  const backup = `${backupRoot}/${label}`;
  try {
    if (existsSync(target)) retry(() => copy(target, backup));
    retry(() => rmSync(target, { recursive: true, force: true }));
    retry(() => copy(SRC, target));
    results.push({ target, ok: true });
    console.log('deployed', target);
  } catch (error) {
    results.push({ target, ok: false, error: String(error?.message ?? error) });
    console.log('FAILED', target, String(error?.message ?? error));
  }
}
console.log(JSON.stringify({ backupRoot, results }, null, 2));
