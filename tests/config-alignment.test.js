/**
 * Config 与 DEFAULT_CONFIG 必须给出同一套默认键/值。
 * 两边分开维护（Schema 在 index.js，纯数据在 config.js），漏一个键就会让
 * 运行期配置和测试/命令展示各说各话，所以在这里锁死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Config } from '../lib/index.js';
import { DEFAULT_CONFIG } from '../lib/config.js';

test('Config 与 DEFAULT_CONFIG 键集合一致', () => {
  const schemaKeys = Object.keys(Config.dict).sort();
  const defaultKeys = Object.keys(DEFAULT_CONFIG).sort();
  assert.deepEqual(schemaKeys, defaultKeys);
});

test('Config 解析出的默认值与 DEFAULT_CONFIG 一致', () => {
  const resolved = Config({});
  for (const key of Object.keys(DEFAULT_CONFIG).sort()) {
    assert.deepEqual(resolved[key], DEFAULT_CONFIG[key], `${key} 的默认值两边不一致`);
  }
});
