/** 梗库：查询词识别、查库、给模型的排版（local meme db）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  cleanMemeText,
  extractMemeQuery,
  formatMeme,
  lookupMeme,
  openMemeDb,
} from '../lib/meme.js';

const MEME_DB = 'C:\\Users\\HP\\.dsh\\dsh-soul\\memes.db';
const hasDb = existsSync(MEME_DB);

test('梗：从问句里抽出查询词，指代/超长不抽', () => {
  assert.equal(extractMemeQuery('大水理论是什么梗'), '大水理论');
  assert.equal(extractMemeQuery('大水理论到底啥意思啊'), '大水理论');
  assert.equal(extractMemeQuery('这个梗什么意思'), null);
  assert.equal(extractMemeQuery('那句话怎么来的'), null);
  assert.equal(extractMemeQuery('这个长到超过十二个字的奇怪词条是什么意思啊'), null);
});

test('梗：裸词才算查询，问候与应答不算', () => {
  assert.equal(extractMemeQuery('大水理论'), '大水理论');
  assert.equal(extractMemeQuery('在吗'), null);
  assert.equal(extractMemeQuery('哈哈'), null);
  assert.equal(extractMemeQuery('好的'), null);
});

test('梗：剥掉句首 @ 和唤醒词', () => {
  assert.equal(cleanMemeText('大肥鱼，大水理论是什么梗'), '大水理论是什么梗');
  assert.equal(cleanMemeText('@某人 大水理论'), '大水理论');
  assert.equal(extractMemeQuery('@某人 大水理论'), '大水理论');
});

test('梗：给模型的排版把「怎么用」排在「出处」前面', () => {
  const text = formatMeme({
    title: '测试梗',
    slug: 'test',
    tags: '测试',
    usage: '拿来接一句',
    origin: '很久以前',
    other: '',
  });
  const iUse = text.indexOf('怎么用');
  const iOrigin = text.indexOf('出处');
  assert.ok(iUse > 0 && iOrigin > iUse, '用法段应在出处段之前');
  assert.match(text, /cnmeme\.wiki\/词条\/test/);
});

test('梗：库缺失时 openMemeDb 返回 null 而不是抛错', () => {
  assert.equal(openMemeDb('C:\\definitely\\missing\\memes.db'), null);
  assert.equal(openMemeDb(''), null);
});

test('梗：真实词库里能查到词条，查不到返回 null', (t) => {
  if (!hasDb) return t.skip('memes.db 未部署');
  const db = openMemeDb(MEME_DB);
  assert.ok(db, '梗库应能打开');
  const hit = lookupMeme(db, '大水理论');
  assert.ok(hit, '大水理论应命中');
  assert.ok(hit.usage.length > 0 || hit.origin.length > 0, '命中词条应有内容');
  assert.equal(lookupMeme(db, 'zzz不存在的梗zzz'), null);
  assert.equal(lookupMeme(db, '今天天气不错', { strict: true }), null, 'strict 不把普通短句当梗');
  db.close();
});
