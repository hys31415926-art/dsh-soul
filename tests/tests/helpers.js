/**
 * tests/helpers.js — 测试公用工具：临时数据库、伪宿主 ctx、常用配置。
 *
 * 伪 ctx 只实现插件真正用到的契约：logger / on / emit / effect / get / tools。
 * 这样可以不启动宿主进程就覆盖 hooks、tools、commands、skill、index 的装配逻辑。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/memory/store.js';
import { DEFAULT_CONFIG } from '../lib/config.js';

/** 建一个临时 SQLite 记忆库，测试结束自动关闭并删目录。 */
export function makeTempStore(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soul-test-'));
  const path = join(dir, 'soul.db');
  const store = openStore(path);
  t.after(() => {
    try { store.close(); } catch { /* already closed */ }
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      leakedDirs.delete(dir);
    } catch {
      // Windows 上若同一测试还开着另一个句柄（如 reopen 后的 store），这里会 EBUSY。
      // 记下来，进程退出时再删一次，避免每跑一轮测试就在 TEMP 留一堆空库。
      leakedDirs.add(dir);
    }
  });
  return { store, path, dir };
}

/** 句柄释放后仍删不掉的临时目录，进程退出时兜底清理一次。 */
const leakedDirs = new Set();
process.once('exit', () => {
  for (const dir of leakedDirs) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 留给系统清理 */ }
  }
});

/** 伪宿主 ctx：事件总线 + effect + get(name) 服务查找 + 服务属性（ctx.tools 等）。 */
export function makeCtx(services = {}) {
  const listeners = new Map();
  const ctx = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    listeners,
    on(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
    },
    effect(fn) {
      const dispose = fn();
      return () => { if (typeof dispose === 'function') dispose(); };
    },
    get(name) { return services[name]; },
  };
  return Object.assign(ctx, services);
}

/** 伪 tools 服务：记录注册的工具，返回卸载函数。 */
export function fakeTools() {
  const tools = [];
  return {
    tools,
    register(tool) {
      tools.push(tool);
      return () => {
        const index = tools.indexOf(tool);
        if (index >= 0) tools.splice(index, 1);
      };
    },
  };
}

/** 伪 systemPrompt 服务。 */
export function fakeSystemPrompt() {
  const sections = [];
  return {
    sections,
    getSectionOrder() { return 0; },
    section(section) { sections.push(section); return () => {}; },
  };
}

/** 伪 commands 服务。 */
export function fakeCommands() {
  const definitions = [];
  return {
    definitions,
    register(definition) { definitions.push(definition); return () => {}; },
  };
}

/** 伪 skills 服务。 */
export function fakeSkills() {
  const skills = [];
  return {
    skills,
    register(skill) { skills.push(skill); return () => {}; },
  };
}

/** 测试配置：在默认值上覆盖少量字段。 */
export function testConfig(overrides = {}) {
  return { ...DEFAULT_CONFIG, curationMinutes: 0, logToFile: false, ...overrides };
}

/** 常用假会话。 */
export function makeSession(id = 's-test', header = {}) {
  return { id, header: { origin: 'user', cwd: 'C:/workspace', ...header } };
}

/** 一条用户消息事件。 */
export function userMessageEvent(text, source = { kind: 'user' }) {
  return {
    type: 'user/message',
    data: { role: 'user', content: [{ type: 'text', text }], source },
  };
}
