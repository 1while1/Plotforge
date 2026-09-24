const test = require('node:test');
const assert = require('node:assert/strict');
const { db, createTempLocation, cleanup } = require('./helpers/temp-db');
const actionStore = require('../server/actionStore');
const { executeTool } = require('../server/tools/executor');
const registry = require('../server/tools/registry');

// 「生成总结」语义统一（方向报告 1.2）：生成工具显式标注不落库；
// 保存走独立确认工具；卷总结补普通界面入口（POST /volumes/:id/summary 已有）。
test.beforeEach(() => actionStore.clear());

test('generate tools are labeled not-saved; save tools persist after confirmation', async () => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['总结语义书']).lastInsertRowid;
  const volId = db.run('INSERT INTO volumes (book_id, title, sort_order) VALUES (?, ?, 1)', [bookId, '卷一']).lastInsertRowid;
  const chId = db.run('INSERT INTO chapters (book_id, volume_id, title, content, summary, sort_order) VALUES (?, ?, ?, ?, ?, 1)',
    [bookId, volId, '第一章', '正文。', '既有的章总结']).lastInsertRowid;
  const context = { profile: 'agent', bookId, sessionId: 'agent:s1', model: 'test-model', source: 'agent', actor: 'author' };

  // 1) 注册表：生成工具的描述必须声明不落库
  const toolNames = new Set(registry.listTools('agent').map(t => t.name));
  assert.ok(toolNames.has('generate_volume_summary'));
  assert.ok(toolNames.has('save_volume_summary'), '保存卷总结工具应进 agent profile');
  assert.ok(toolNames.has('save_chapter_summary'));
  const genVol = registry.descriptor('generate_volume_summary');
  const genCh = registry.descriptor('summarize_chapter');
  assert.ok(genVol && genVol.description.includes('不落库'), 'generate_volume_summary 描述应声明不落库');
  assert.ok(genCh && (genCh.description.includes('不写入') || genCh.description.includes('不保存')), 'summarize_chapter 描述应声明不保存');

  // 2) save_volume_summary：先确认信封后落库
  const conf = await executeTool(context, 'save_volume_summary', { volume_id: volId, summary: '第一卷：北境开局。' });
  assert.equal(conf.status, 'confirmation_required');
  assert.ok(conf.confirmation.preview.action.includes('卷一'));
  // S5-01：确认执行传信封里服务端绑定后的 args（镜像生产路由 chat.js/agent.js 的 action.args）——
  // 信封创建时已注入 source_fingerprint，用原始参数重发会与信封签名不一致（CONFIRMATION_MISMATCH）
  const saved = await executeTool(context, 'save_volume_summary', actionStore.get(conf.confirmation.id).args, conf.confirmation.id);
  // book_summary_stale：卷总结变化向书层传播的结果（4.1 书层，本用例书摘要未存 → false）
  assert.equal(saved.volume_id, volId);
  assert.equal(saved.saved, true);
  assert.equal(saved.book_summary_stale, false);
  assert.equal(typeof saved.source_fingerprint, 'string', 'S5-01：结果必须记录来源指纹');
  assert.equal(db.get('SELECT summary FROM volumes WHERE id = ?', [volId]).summary, '第一卷：北境开局。');

  // 3) save_chapter_summary：同样走确认
  const conf2 = await executeTool(context, 'save_chapter_summary', { chapter_id: chId, summary: '新的章总结。' });
  assert.equal(conf2.status, 'confirmation_required');
  const saved2 = await executeTool(context, 'save_chapter_summary', actionStore.get(conf2.confirmation.id).args, conf2.confirmation.id);
  assert.equal(saved2.saved, true);
  assert.equal(db.get('SELECT summary FROM chapters WHERE id = ?', [chId]).summary, '新的章总结。');

  cleanup(location);
});
