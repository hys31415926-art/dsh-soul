import { readFileSync, writeFileSync } from 'node:fs';

const p = 'C:/Users/HP/Desktop/work/soul-build/lib/index.js';
let s = readFileSync(p, 'utf8');

s = s.replace(
  "import { readFileSync } from 'node:fs';",
  "import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';\nimport { DatabaseSync } from 'node:sqlite';",
);

const archiveFn = `const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 合并前的 dsh-soul 用的是另一套表（facts/episodes/...）。检测到旧库就备份成
 * \`<db>.pre-merge-<ts>.bak\`，再删掉主库与 WAL，由新插件重建空库。
 * 旧记忆按约定不继承（用户 m00122：记忆库先删掉）。
 */
function archiveLegacySoulDb(dbPath, logger) {
  try {
    if (!existsSync(dbPath)) return false;
    let legacy = false;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
        const names = new Set(rows.map((row) => String(row.name)));
        legacy = names.has('facts') && !names.has('memories');
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
    if (!legacy) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = dbPath + '.pre-merge-' + stamp + '.bak';
    copyFileSync(dbPath, archive);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = dbPath + suffix;
      if (existsSync(file)) rmSync(file, { force: true });
    }
    logger.info('检测到合并前的 soul 库，已备份到 ' + archive + ' 并重建空库');
    return true;
  } catch (error) {
    logger.warn('旧库备份/重建失败，继续尝试直接打开：', error?.message ?? error);
    return false;
  }
}`;

s = s.replace("const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));", archiveFn);

s = s.replace(
  "  let store;\n  try {\n    store = openStore(paths.dbPath);",
  "  let store;\n  try {\n    archiveLegacySoulDb(paths.dbPath, logger);\n    store = openStore(paths.dbPath);",
);

writeFileSync(p, s, 'utf8');
console.log('index.js patched, length', s.length);
