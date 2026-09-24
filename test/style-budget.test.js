// 系统提示词预算契约（2026-09-11 委托方要求：「系统提示词必须可以容纳 15000 汉字」）。
//
// 三件事必须被钉住：
//   ① identity 单节预算不再是卡点（旧 2500 字符，写 15000 汉字会被截断）；
//   ② 风格层单开一节，有独立预算，不挤占 identity；
//   ③ 全局预算下限抬高，但永不越过模型窗口本身（否则把「写不进去」换成「上游报错」，更糟）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const identity = require('../server/context/providers/identity');
const styleProvider = require('../server/context/providers/style');
const context = require('../server/context');
const { estimateTokens } = require('../server/contextBudget');
const { systemPromptTokenBudget } = require('../server/llm');

async function setup(t) {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  t.after(() => cleanup(location));
  return location;
}

test('identity 单节预算足以容纳 15000 汉字（旧 2500 字符是真正的卡点）', () => {
  assert.ok(
    identity.budget >= 15000,
    `identity 单节预算 ${identity.budget} 字符不足以容纳 15000 汉字`
  );
});

test('15000 汉字的本书提示词：端到端组装后不被截断，且全局预算放行', async t => {
  await setup(t);
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['长提示词书']).lastInsertRowid;
  // 造 15000 个汉字（不是字符——用实义汉字，考验 CJK 计数路径）
  const unit = '这是一段用于容量校验的中文提示词内容';  // 18 汉字
  const longPrompt = '字'.repeat(15000 - unit.repeat(830).length) + unit.repeat(830);
  assert.equal(longPrompt.length, 15000);
  db.run('UPDATE books SET system_prompt = ? WHERE id = ?', [longPrompt, bookId]);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);

  // 单节 build 不裁剪（交给组装器统一裁）
  const built = identity.build({ book, db });
  assert.ok(built.startsWith(longPrompt.slice(0, 50)), '提示词原文应在最前');
  assert.ok(built.includes(longPrompt.slice(-50)), '结尾内容必须存活——不能只留开头');
  assert.ok(!built.includes('已截断'), '单个 provider 不做截断，由组装器统一处理');

  // 组装器：全局预算须放行完整提示词
  const assembled = await context.assembleDetailed({
    book, chapterId: null, db,
    systemTokenBudget: systemPromptTokenBudget(),
  });
  const identityPart = assembled.parts.find(p => p.name === identity.title);
  assert.ok(identityPart, '创作准则节应出现在组装结果里');
  assert.equal(identityPart.truncated, false, '15000 汉字提示词不得被预算截断');
  assert.ok(
    assembled.text.includes(longPrompt.slice(-50)),
    '组装后的系统提示词必须保留提示词结尾——这是「容纳 15000 汉字」的直接证据'
  );
  // 15000 汉字 ≈ 10500 token（CJK 0.7/字），远小于全局预算
  assert.ok(estimateTokens(built) < systemPromptTokenBudget(), '提示词 token 数须小于全局预算');
});

test('风格层单开一节：独立预算、不挤占 identity、可单独关闭', async t => {
  await setup(t);
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['双节书']).lastInsertRowid;
  const longPrompt = '本书提示词内容校验。'.repeat(600).slice(0, 8000);
  db.run('UPDATE books SET system_prompt = ? WHERE id = ?', [longPrompt, bookId]);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);

  const assembled = await context.assembleDetailed({
    book, chapterId: null, db, systemTokenBudget: systemPromptTokenBudget(),
  });
  const names = assembled.parts.map(p => p.name);
  assert.ok(names.includes(identity.title) && names.includes(styleProvider.title), '两节应同时存在');
  assert.equal(styleProvider.priority, 5, 'style 排在 identity(0) 之后');
  assert.notEqual(styleProvider.budget, identity.budget, '两节各有独立预算');

  // 风格层被关掉时，identity 内容一字不少
  db.run("INSERT INTO settings (key, value) VALUES ('style_layer_enabled', '0')");
  const off = await context.assembleDetailed({
    book, chapterId: null, db, systemTokenBudget: systemPromptTokenBudget(),
  });
  assert.ok(!off.parts.map(p => p.name).includes(styleProvider.title), '关闭后风格节应消失');
  const identityOff = off.parts.find(p => p.name === identity.title);
  assert.ok(identityOff.tokens >= estimateTokens(longPrompt), '身份节内容不应因风格层关闭而变化');
});

test('全局预算：下限抬高但不越过模型窗口（不把「写不进去」换成「上游报错」）', async t => {
  await setup(t);
  const setWindow = (v) => db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['context_window', String(v)]
  );

  // 大窗口：走「窗口 − 预留」，远大于下限
  setWindow(200000);
  const big = systemPromptTokenBudget();
  assert.equal(big, 200000 - 4096);
  assert.ok(big > 15000, '大窗口下预算必须容得下 15000 汉字');

  // 小窗口：下限被窗口本身钳住，不得谎报超过窗口的预算
  setWindow(8000);
  const small = systemPromptTokenBudget();
  assert.ok(small <= 8000 - 1024, `窗口 8000 时预算 ${small} 不得超过窗口保护线`);
  assert.ok(small > 0);

  // 下限生效区间：窗口 12000 时「窗口−预留」= 7904 < 下限 12000，取下限；
  // 但窗口保护线（窗口−1024=10976）仍优先——永不谎报超过窗口的预算
  setWindow(12000);
  assert.equal(systemPromptTokenBudget(), 10976);
  assert.ok(systemPromptTokenBudget() > 12000 - 4096, '下限确实抬高了预算（否则会是 7904）');
});

test('预算紧张时风格层是「可牺牲的一节」，不是硬塞', async t => {
  await setup(t);
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['紧张预算书']).lastInsertRowid;
  const longPrompt = '紧张预算下的本书提示词。'.repeat(700).slice(0, 9000);
  db.run('UPDATE books SET system_prompt = ? WHERE id = ?', [longPrompt, bookId]);
  const book = db.get('SELECT * FROM books WHERE id = ?', [bookId]);

  // 预算刚好只够 identity（含固定后缀），风格节必须让路而不是抢额度
  const identityTokens = estimateTokens(identity.build({ book, db }));
  const tight = await context.assembleDetailed({
    book, chapterId: null, db, systemTokenBudget: identityTokens + 10,
  });
  const identityPart = tight.parts.find(p => p.name === identity.title);
  assert.ok(identityPart, '身份节必须保留（优先级最高）');
  assert.equal(identityPart.truncated, false, 'identity 应在预算内完整保留');
  const stylePart = tight.parts.find(p => p.name === styleProvider.title);
  assert.ok(!stylePart || stylePart.truncated, '预算紧张时风格节应被裁或丢弃');
});
