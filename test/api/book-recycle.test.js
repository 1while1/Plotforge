const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { db, createTempLocation, cleanup } = require('../helpers/temp-db');
const { seedBook } = require('../../server/migrations/001-character-hub');
const { createApp } = require('../../server/app');
const { listen, json } = require('../helpers/http');
const characters = require('../../server/domain/characters');
const ledger = require('../../server/domain/storyLedger');
const versions = require('../../server/versions');
const cards = require('../../server/style/cards');
const packs = require('../../server/style/packs');

// 删除保护与回收站（方向报告 3.4）：删书前强制统计预览 + 自动整册备份（30 天）+ 恢复
test('book delete previews damage, backs up automatically, and restores from recycle bin', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['回收站测试书']).lastInsertRowid;
  db.transaction(() => seedBook(db, bookId));
  const charId = characters.createCharacter(bookId, { name: '林野' }).character.id;
  const chId = db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)', [bookId, '第一章', '林野在废弃车站醒来，口袋里只剩半张地图。']).lastInsertRowid;
  versions.snapshot(chId, 'before-test');
  ledger.commitEvent(bookId, { title: '醒来', chapter_id: chId, changes: [{ change_kind: 'character_state', subject_ref: charId, field_key: 'health', old_value: null, new_value: '虚弱' }] });
  db.run('INSERT INTO messages (book_id, role, content, created_at) VALUES (?, ?, ?, datetime(\'now\'))', [bookId, 'user', '写一段']);

  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  // 1) 删除预览：强制展示将失去的内容统计
  const preview = await json(http.baseUrl, 'GET', `/api/books/${bookId}/delete-preview`);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.chapters, 1);
  assert.equal(preview.body.characters >= 1, true);
  assert.equal(preview.body.events, 1);
  assert.ok(preview.body.words > 0);
  assert.ok(preview.body.versions >= 1);

  // 2) 删除：自动备份进回收站，成功后书与级联数据清空
  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}`);
  assert.equal(del.status, 200);
  assert.ok(del.body.backup_file, '响应应带备份文件名');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM books WHERE id = ?', [bookId]).n, 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n, 0);
  const backupPath = path.join(path.dirname(db.getFilePath()), 'backups', del.body.backup_file);
  assert.ok(fs.existsSync(backupPath), '备份文件应落盘');

  // 3) 回收站列表可见
  const bin = await json(http.baseUrl, 'GET', '/api/books/recycle-bin');
  assert.equal(bin.status, 200);
  assert.ok(bin.body.backups.some(b => b.file === del.body.backup_file && b.book_id === bookId));
  assert.ok(bin.body.retention_days >= 30);

  // 4) 恢复：整册按原 id 回插，章节/版本/事件/人物/消息全回来
  const restore = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/restore', { file: del.body.backup_file, reindex: false });
  assert.equal(restore.status, 201);
  assert.equal(restore.body.book.id, bookId);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n, 1, '章节应恢复');
  const ch = db.get('SELECT * FROM chapters WHERE book_id = ?', [bookId]);
  assert.equal(ch.title, '第一章');
  assert.ok(ch.content.includes('废弃车站'));
  assert.ok(db.get('SELECT COUNT(*) AS n FROM chapter_versions WHERE chapter_id = ?', [chId]).n >= 1, '版本快照应恢复');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM story_events WHERE book_id = ?', [bookId]).n, 1, '事件应恢复');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM messages WHERE book_id = ?', [bookId]).n, 1, '消息应恢复');
  assert.ok(db.get('SELECT COUNT(*) AS n FROM character_state_values WHERE book_id = ?', [bookId]).n >= 1, '状态投影应恢复');

  // 5) 重复恢复同 id：409 拒绝覆盖
  const again = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/restore', { file: del.body.backup_file, reindex: false });
  assert.equal(again.status, 409);

  // 6) 永久删除备份 + 路径穿越防护
  const purge = await json(http.baseUrl, 'DELETE', `/api/books/recycle-bin/${encodeURIComponent(del.body.backup_file)}`);
  assert.equal(purge.status, 200);
  assert.equal(fs.existsSync(backupPath), false);
  const evil = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/restore', { file: '../novel.db', reindex: false });
  assert.equal(evil.status, 404, '路径穿越文件名应被拒绝');
});

// C12：整册恢复必须带回作家卡绑定，且不动被多本书共享的卡内容。
test('整册恢复带回作家卡绑定：role/sort_order/生效链一致，共享卡不被覆盖', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['绑卡书']).lastInsertRowid;
  const otherId = db.run('INSERT INTO books (title) VALUES (?)', ['共享卡书']).lastInsertRowid;
  const chId = db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)', [bookId, '第一章', '绑卡书的正文。']).lastInsertRowid;
  versions.snapshot(chId, 'before-c12');

  const main = cards.createPack({ name: 'C12主卡', kind: 'preset', persona: '主卡人设' });
  cards.addRule(main.id, { title: '主卡规则', rule: '主卡规则正文', severity: 'must' });
  cards.addSample(main.id, { title: '主卡范文', text: '主卡范文正文若干字。' });
  const aux = cards.createPack({ name: 'C12辅卡', kind: 'preset', persona: '辅卡人设' });
  cards.addRule(aux.id, { title: '辅卡规则', rule: '辅卡规则正文' });
  cards.setBookBindings(bookId, [{ packId: main.id, role: 'main' }, { packId: aux.id, role: 'aux', sortOrder: 3 }]);
  // 主卡同时绑在另一本书上（共享资产）：恢复绝不能动它的内容
  cards.setBookBindings(otherId, [{ packId: main.id, role: 'main' }]);

  const beforeBindings = db.all(
    'SELECT book_id, pack_id, role, sort_order, enabled FROM book_style_packs WHERE book_id = ? ORDER BY role, sort_order',
    [bookId]
  );
  const beforeResolve = packs.resolveForBook(bookId);
  assert.equal(beforeResolve.source, 'bound');
  const beforeOtherText = packs.compileCardsText(packs.resolveForBook(otherId).chain.map(p => p.id));

  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}`);
  assert.equal(del.status, 200);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM book_style_packs WHERE book_id = ?', [bookId]).n, 0, '删书应清掉本书绑定（级联），共享书绑定保留');

  // v2 备份含绑定与引用卡快照（manifest）；S3-01 起版本为 3（会话两表）；S4-04a 起为 4（规划笔记/交接两表）
  const backupPath = path.join(path.dirname(db.getFilePath()), 'backups', del.body.backup_file);
  const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(data.version, 4, '备份版本应为 4（v2 绑定 + S3-01 会话表 + S4-04a 规划笔记/交接表）');
  assert.equal(data.style.bindings.length, 2, '备份应含 book_style_packs 行');
  const snapIds = data.style.packs.map(p => p.id).sort();
  assert.deepEqual(snapIds, [main.id, aux.id].sort(), '引用卡的快照应随备份保存');
  assert.ok(data.style.packs[0].rules.length >= 1 || data.style.packs[1].rules.length >= 1, '快照应含规则');

  // 预览：每张绑定的卡都报告「已存在」
  const preview = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/preview', { file: del.body.backup_file });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.style.legacy, false);
  assert.equal(preview.body.style.missing.length, 0);
  assert.equal(preview.body.style.bindings.length, 2);

  // 恢复：绑定按原 role/sort_order 回来，生效链不变
  const restore = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/restore', { file: del.body.backup_file, reindex: false });
  assert.equal(restore.status, 201);
  assert.equal(restore.body.style.restored_bindings, 2);
  const afterBindings = db.all(
    'SELECT book_id, pack_id, role, sort_order, enabled FROM book_style_packs WHERE book_id = ? ORDER BY role, sort_order',
    [bookId]
  );
  assert.deepEqual(afterBindings, beforeBindings, '恢复后绑定应与删除前逐字段一致');
  const afterResolve = packs.resolveForBook(bookId);
  assert.equal(afterResolve.source, 'bound', '不得回落默认卡');
  assert.deepEqual(afterResolve.chain.map(p => p.id), beforeResolve.chain.map(p => p.id));

  // 共享卡不被覆盖：另一本书的编译文本与卡内容完全不变
  assert.equal(packs.compileCardsText(packs.resolveForBook(otherId).chain.map(p => p.id)), beforeOtherText);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM style_rules WHERE pack_id = ?', [main.id]).n, 1);
  assert.equal(db.get('SELECT persona FROM style_packs WHERE id = ?', [main.id]).persona, '主卡人设');
});

// C12：引用的卡已删时，默认整单拒绝（不留半恢复）；作者显式允许才部分恢复并逐项报告缺失。
test('依赖缺失：默认 409 拒绝且无半恢复，显式允许才恢复并报告缺失绑定', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['缺依赖书']).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)', [bookId, '第一章', '缺依赖书正文。']);

  const main = cards.createPack({ name: '将被删除的主卡', kind: 'preset', persona: '消失的主卡' });
  const aux = cards.createPack({ name: '仍在的辅卡', kind: 'preset' });
  cards.setBookBindings(bookId, [{ packId: main.id, role: 'main' }, { packId: aux.id, role: 'aux' }]);

  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}`);
  assert.equal(del.status, 200);
  cards.deletePack(main.id); // 备份之后、恢复之前主卡被删 → 依赖缺失

  // 默认：整单 409，库中无任何半恢复痕迹
  const refused = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/restore', { file: del.body.backup_file, reindex: false });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'BACKUP_STYLE_DEPENDENCY_MISSING');
  assert.equal(refused.body.error.details.missing.length, 1);
  assert.equal(refused.body.error.details.missing[0].pack_id, main.id);
  assert.equal(refused.body.error.details.missing[0].name, '将被删除的主卡');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM books WHERE id = ?', [bookId]).n, 0, '拒绝时不得留下半恢复的书');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n, 0);

  // 预览如实报告：主卡缺失、辅卡仍在
  const preview = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/preview', { file: del.body.backup_file });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.style.missing.length, 1);
  const byExists = Object.fromEntries(preview.body.style.bindings.map(b => [b.pack_id, b.exists]));
  assert.equal(byExists[main.id], false);
  assert.equal(byExists[aux.id], true);

  // 显式允许部分恢复：正文与辅卡绑定回来，主卡绑定缺失被逐项报告
  const partial = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/restore', { file: del.body.backup_file, reindex: false, allow_partial_style: true });
  assert.equal(partial.status, 201);
  assert.equal(partial.body.style.restored_bindings, 1);
  assert.equal(partial.body.style.missing.length, 1);
  assert.equal(partial.body.style.missing[0].role, 'main');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n, 1, '正文照常恢复');
  const restored = db.all('SELECT pack_id, role FROM book_style_packs WHERE book_id = ?', [bookId]);
  assert.deepEqual(restored, [{ pack_id: aux.id, role: 'aux' }], '只剩辅卡绑定，主卡缺失留空');
  const resolve = packs.resolveForBook(bookId);
  assert.ok(resolve.chain.some(p => p.id === aux.id), '辅卡仍在生效链上');
});

// C12：旧版（v1，无 style 节）备份允许正文恢复，但恢复预览与结果必须明确列出不可恢复项。
test('旧版 v1 备份：正文可恢复，绑定列为不可恢复项', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', ['旧版备份书']).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)', [bookId, '第一章', '旧版备份书正文。']);
  const main = cards.createPack({ name: '旧版主卡', kind: 'preset' });
  cards.setBookBindings(bookId, [{ packId: main.id, role: 'main' }]);

  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}`);
  assert.equal(del.status, 200);
  // 把备份降级成旧版形态：无 style 节、version=1
  const backupPath = path.join(path.dirname(db.getFilePath()), 'backups', del.body.backup_file);
  const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  delete data.style;
  data.version = 1;
  fs.writeFileSync(backupPath, JSON.stringify(data));

  const preview = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/preview', { file: del.body.backup_file });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.style.legacy, true, '预览应标出这是不含绑定的旧版备份');
  assert.ok(preview.body.style.unavailable.some(s => s.indexOf('作家卡绑定') >= 0), '不可恢复项必须列明作家卡绑定');

  const restore = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/restore', { file: del.body.backup_file, reindex: false });
  assert.equal(restore.status, 201, '旧版备份仍允许恢复正文');
  assert.equal(restore.body.style.legacy, true);
  assert.ok(restore.body.style.unavailable.length >= 1, '恢复结果也要列出不可恢复项');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n, 1, '正文照常恢复');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM book_style_packs WHERE book_id = ?', [bookId]).n, 0, '旧版备份无从恢复绑定');
});

// G4 审计 P2-1：书名含全角标点（，·）时，自动备份必须在回收站可见、可预览、可恢复、可删除。
// 修复前：sanitizeTitle 只替换 Windows 非法字符与空白，全角标点进入文件名；而
// safeBackupPath/listBackups 的字符类只认 [\w\u4e00-\u9fff._-]，导致文件在盘上却
// 对外 404/不可见（真实库 book-43「·」与 #18「，」即中招，删书后无法从备份恢复）。
test('书名含全角标点时备份可见可恢复可删除（G4 审计 P2-1）', async t => {
  const location = createTempLocation();
  await db.init({ filePath: location.filePath });
  const title = '她在2000年的第一天，敲响了我的门·修订';
  const bookId = db.run('INSERT INTO books (title) VALUES (?)', [title]).lastInsertRowid;
  db.run('INSERT INTO chapters (book_id, title, content, sort_order) VALUES (?, ?, ?, 1)', [bookId, '第一章', '全角标点书名备份测试正文。']);

  const http = await listen(createApp());
  t.after(async () => { await http.close(); cleanup(location); });

  const del = await json(http.baseUrl, 'DELETE', `/api/books/${bookId}`);
  assert.equal(del.status, 200);
  const file = del.body.backup_file;
  assert.ok(file, '响应应带备份文件名');
  assert.ok(fs.existsSync(path.join(path.dirname(db.getFilePath()), 'backups', file)), '备份文件应落盘');

  // 红点 1：listBackups 过滤正则漏掉该文件 → 回收站列表不可见
  const bin = await json(http.baseUrl, 'GET', '/api/books/recycle-bin');
  assert.equal(bin.status, 200);
  assert.ok(bin.body.backups.some(b => b.file === file && b.book_id === bookId), '回收站列表必须列出含全角标点书名的备份');

  // 红点 2：safeBackupPath 拒绝该名字 → preview/restore 404「备份文件不存在」
  const preview = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/preview', { file });
  assert.equal(preview.status, 200, '含全角标点书名的备份必须可预览');
  const restore = await json(http.baseUrl, 'POST', '/api/books/recycle-bin/restore', { file, reindex: false });
  assert.equal(restore.status, 201, '含全角标点书名的备份必须可恢复');
  assert.equal(restore.body.book.id, bookId);
  assert.equal(db.get('SELECT title FROM books WHERE id = ?', [bookId]).title, title, '书名原样恢复');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM chapters WHERE book_id = ?', [bookId]).n, 1, '章节应恢复');

  // 红点 3：deleteBackup 404 → 孤儿文件只增不减
  const rm = await json(http.baseUrl, 'DELETE', `/api/books/recycle-bin/${encodeURIComponent(file)}`);
  assert.equal(rm.status, 200, '含全角标点书名的备份必须可删除');
  assert.equal(fs.existsSync(path.join(path.dirname(db.getFilePath()), 'backups', file)), false, '删除后文件应消失');
});
