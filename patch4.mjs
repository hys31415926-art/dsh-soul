import { readFileSync, writeFileSync } from 'node:fs';

const p = 'C:/Users/HP/Desktop/work/soul-build/lib/index.js';
let s = readFileSync(p, 'utf8');

const newFn = `/**
 * 合并前的记忆库（旧 dsh-companion / 旧 dsh-soul）不继承：先备份成
 * \`<db>.pre-merge-<ts>.bak\`，再删掉主库与 WAL，由新插件重建空库。
 *
 * 判断依据是 meta 里的 plugin.version：只有当前版本号才认为库已经属于本插件，
 * 这样重启不会反复清库。用户 m00122：记忆库先删掉。
 */
function archivePreviousDb(dbPath, logger, currentVersion) {
  try {
    if (!existsSync(dbPath)) return false;
    let keep = false;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare("SELECT v FROM meta WHERE k = 'plugin.version'").all();
        keep = rows.length > 0 && String(rows[0].v) === String(currentVersion);
      } finally {
        db.close();
      }
    } catch {
      keep = false;
    }
    if (keep) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = dbPath + '.pre-merge-' + stamp + '.bak';
    copyFileSync(dbPath, archive);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = dbPath + suffix;
      if (existsSync(file)) rmSync(file, { force: true });
    }
    logger.info('检测到合并前的记忆库，已备份到 ' + archive + ' 并重建空库');
    return true;
  } catch (error) {
    logger.warn('旧库备份/重建失败，继续尝试直接打开：', error?.message ?? error);
    return false;
  }
}`;

s = s.replace(/\/\*\*\n \* 合并前的 dsh-soul 用的是另一套表[\s\S]*?\n}\n/, newFn + '\n');
s = s.replace('archiveLegacySoulDb(paths.dbPath, logger);', 'archivePreviousDb(paths.dbPath, logger, version);');

if (s.includes('archiveLegacySoulDb')) throw new Error('old call still present');
writeFileSync(p, s, 'utf8');
console.log('archivePreviousDb installed');
