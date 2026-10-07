const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const base = new URL(process.argv[2] || 'http://127.0.0.1:3119');
if (!['127.0.0.1', 'localhost'].includes(base.hostname) || ['3000', '3100', ''].includes(base.port)) throw new Error('仅允许独立端口的本机隔离实例');
const output = path.resolve(process.argv[3] || path.join(require('node:os').tmpdir(), 'plotforge-live-results'));
const repeats = Math.max(1, Math.min(3, Number(process.argv[4]) || 3));
const only = process.argv[5] || '';
const resumeHistoryMode = process.argv[6] || 'full';
if (!['full', 'minimal'].includes(resumeHistoryMode)) throw new Error('续跑历史模式必须为full或minimal');
const results = [];
const books = [];
let fixture;
let agentConversationId = null;

async function api(method, route, body, raw = false) {
  const response = await fetch(new URL(route, base), { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(180000) });
  if (raw) return response;
  const data = await response.json();
  assert.ok(response.ok, 'HTTP ' + response.status + ' ' + JSON.stringify(data).slice(0, 500));
  return data;
}

async function stream(route, body) {
  const response = await api('POST', route, body, true);
  const wire = await response.text();
  assert.ok(response.ok, 'HTTP ' + response.status + ' ' + wire.slice(0, 500));
  const events = wire.split(String.fromCharCode(10)).filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } }).filter(Boolean);
  const errors = events.filter(event => event.type === 'error');
  assert.equal(errors.length, 0, JSON.stringify(errors).slice(0, 900));
  return events;
}

function done(events) {
  const final = events.find(event => event.type === 'done');
  assert.ok(final, '缺少done事件');
  return final;
}

async function run(name, task) {
  if (only && !name.includes(only)) return;
  const started = Date.now();
  const record = { name, pass: false };
  try { Object.assign(record, await task(record)); record.pass = true; }
  catch (error) { record.error = error.message.slice(0, 1400); }
  record.durationMs = Date.now() - started;
  results.push(record);
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ testedAt: new Date().toISOString(), base: base.origin, results }, null, 2));
  console.log((record.pass ? 'PASS ' : 'FAIL ') + name + ' ' + record.durationMs + 'ms' + (record.error ? ' ' + record.error : ''));
}

async function chapter(bookId, volumeId, title, content, sort) {
  const made = (await api('POST', '/api/books/' + bookId + '/chapters', { volume_id: volumeId, title })).chapter;
  // S1-03 起章节写入强制 expected_revision（缺省 428 CHAPTER_REVISION_REQUIRED）：
  // 夹具必须带上刚读到的 revision，不再发无条件覆盖。
  const saved = (await api('PUT', '/api/books/' + bookId + '/chapters/' + made.id, { content, sort_order: sort, expected_revision: made.revision })).chapter;
  return { ...made, content, sort_order: sort, revision: saved && saved.revision };
}

async function createFixture() {
  const bookId = (await api('POST', '/api/books', { title: 'Agent真实模型验收-目录与确认', intro: '合成测试书，无真实用户小说' })).book.id;
  books.push(bookId);
  await api('PUT', '/api/books/' + bookId, { master_outline: '主角周宁从白塔前往青鹭港。所有章节均为合成测试资料；港口口令直到第二卷第三章末尾才出现。' });
  const firstVolume = (await api('POST', '/api/books/' + bookId + '/volumes', { title: '白塔旧事' })).volume.id;
  const latestVolume = (await api('POST', '/api/books/' + bookId + '/volumes', { title: '青鹭港口' })).volume.id;
  const old = await chapter(bookId, firstVolume, '第1章 白塔', '周宁清晨离开白塔。此时他还不知道港口口令。旧扳手是父亲留下的纪念物。', 1);
  await chapter(bookId, firstVolume, '第2章 河岸', '周宁路过河岸，看见蓝色信封。', 13);
  await chapter(bookId, latestVolume, '第1章 入港', '周宁抵达青鹭港口，向看守打听渡船。', 1);
  await chapter(bookId, latestVolume, '第2章 钥匙', '周宁把铜钥匙放在左侧口袋。他继续等待口令。', 15);
  const latest = await chapter(bookId, latestVolume, '第3章 口令', '周宁等候在青鹭港口。' + '岸边灯火摇曳，潮水拍打石阶，他耐心观察过往的船只。'.repeat(180) + '临别时，守门人低声说：今夜口令是青鹭归帆。周宁把铜钥匙放回左侧口袋。', 16);
  fixture = { bookId, firstVolume, latestVolume, old, latest };
  // S3-02：Agent 面按会话工作（历史由服务端组装）
  agentConversationId = (await api('POST', '/api/conversations', {
    kind: 'agent', scope: 'book', bookId, title: '修复验收 Agent 会话（合成书）',
  })).id;
}

async function writing(body) { return stream('/api/books/' + fixture.bookId + '/chat/stream', { source: 'writing', ...body }); }

async function main() {
  await fs.mkdir(output, { recursive: true });
  await createFixture();
  for (let attempt = 1; attempt <= repeats; attempt++) await run('旧章选中时定位最新正文并读尾-' + attempt, async record => {
    const events = await writing({ chapterId: fixture.old.id, content: '界面选中的不是最新章。请定位最新有正文的章节，实际调用read_chapter读取末尾，然后只回答口令、章节ID和卷章位置。正文很长，请读尾部，不要只读开头。不要修改数据。' });
    record.events = events;
    const final = done(events);
    assert.equal(final.run.status, 'finished');
    assert.ok(final.content.includes('青鹭归帆'), final.content);
    assert.ok(events.some(event => event.type === 'tool' && event.name === 'read_chapter' && event.args.chapterId === fixture.latest.id), '未实际读取最新章节');
    assert.equal(events.filter(event => event.type === 'action').length, 0);
    // S5-02 / R01：事件只是过程，判据是本轮真实读取凭据——明确重读必须有 receipt（chapterId + 读取时 revision + 内容哈希）
    const required = final.run.requiredReads || [];
    assert.ok(required.some(item => item.chapterId === fixture.latest.id), '服务端应生成对最新章的重读要求：' + JSON.stringify(required));
    const receipt = (final.run.readReceipts || []).find(item => item.chapterId === fixture.latest.id);
    assert.ok(receipt, '本轮未产生实际读取凭据：' + JSON.stringify(final.run.readReceipts || []));
    const chapter = (await api('GET', '/api/books/' + fixture.bookId + '/chapters/' + fixture.latest.id)).chapter;
    assert.equal(receipt.revision, chapter.revision, '凭据 revision 必须与当前章版本一致');
    assert.equal(String(receipt.contentHash).length, 64, '凭据必须带正文内容哈希');
    return { answer: final.content, run: final.run, receipt };
  });
  await run('跨轮保留刚才读取的口令和ID', async record => {
    const events = await writing({ chapterId: fixture.latest.id, content: '只复述刚才实际读取到的港口口令和章节ID，不要重新调用工具，也不要写入。' });
    record.events = events;
    const final = done(events);
    assert.ok(final.content.includes('青鹭归帆'), final.content);
    assert.ok(final.content.includes(String(fixture.latest.id)), final.content);
    assert.equal(events.filter(event => event.type === 'tool').length, 0);
    // S5-02：回指「刚才实际读取到的」是历史引用，不是本轮重读要求——不得因此强制重读/暂停
    assert.deepEqual(final.run.requiredReads || [], [], '历史引用不应被当成明确重读要求');
    return { answer: final.content, run: final.run };
  });
  await run('返回历史章不把未来口令当已知剧情', async record => {
    const events = await writing({ chapterId: fixture.old.id, content: '只根据当前选中章及其之前的正文回答：在这个叙事时刻，周宁是否已经得知港口口令？未交代就回答尚未得知，不要透露或查询后续章节。' });
    record.events = events;
    const final = done(events);
    assert.ok(!final.content.includes('青鹭归帆'), final.content);
    assert.match(final.content, /尚未|还不|不知道|未.*得知/);
    return { answer: final.content, run: final.run };
  });
  await run('建章自增-确认前停住-用真实新ID续写', async record => {
    const before = (await api('GET', '/api/books/' + fixture.bookId + '/chapters')).chapters;
    const events = await writing({ chapterId: fixture.old.id, content: '请在第二卷末尾新建下一章，标题只用自动章节编号、不要自拟标题，然后把“铜钥匙仍在左侧口袋，周宁终于登上渡船。”写成该章正文，只要这一句话，不扩写。请先创建，等我确认后再继续写入新章，不要改旧章。' });
    record.createEvents = events;
    const final = done(events);
    assert.equal(final.run.status, 'awaiting_confirmation', final.content);
    const actions = events.filter(event => event.type === 'action');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].name, 'create_chapter');
    assert.equal((await api('GET', '/api/books/' + fixture.bookId + '/chapters')).chapters.length, before.length);
    const created = await api('POST', '/api/books/' + fixture.bookId + '/chat-actions/' + actions[0].id + '/confirm', { approve: true });
    const newChapter = created.result.chapter;
    record.createdChapter = { id: newChapter.id, title: newChapter.title, volume_id: newChapter.volume_id, sort_order: newChapter.sort_order };
    assert.equal(newChapter.volume_id, fixture.latestVolume);
    assert.equal(newChapter.sort_order, 17);
    assert.match(newChapter.title, /^第4章/);
    const resumed = await writing({ resumeActionId: actions[0].id, chapterId: fixture.old.id });
    record.resumeEvents = resumed;
    assert.equal(done(resumed).run.status, 'awaiting_confirmation', done(resumed).content);
    const writes = resumed.filter(event => event.type === 'action');
    assert.equal(writes.length, 1);
    assert.ok(['append_chapter', 'replace_chapter'].includes(writes[0].name));
    assert.equal(writes[0].args.chapterId, newChapter.id);
    assert.equal((await api('GET', '/api/books/' + fixture.bookId + '/chapters/' + newChapter.id)).chapter.content, '');
    await api('POST', '/api/books/' + fixture.bookId + '/chat-actions/' + writes[0].id + '/confirm', { approve: true });
    const saved = (await api('GET', '/api/books/' + fixture.bookId + '/chapters/' + newChapter.id)).chapter;
    assert.ok(saved.content.includes('铜钥匙仍在左侧口袋'), saved.content);
    assert.equal((await api('GET', '/api/books/' + fixture.bookId + '/chapters/' + fixture.old.id)).chapter.content, fixture.old.content);
    return { createdChapter: record.createdChapter, savedChars: saved.content.length };
  });
  await run('写作页确认即停和拒绝续跑', async record => {
    const events = await writing({ chapterId: fixture.old.id, content: '请在现有末卷新建一章，标题自动编号，不要执行其他操作。' });
    record.events = events;
    assert.equal(done(events).run.status, 'awaiting_confirmation');
    const actions = events.filter(event => event.type === 'action');
    assert.equal(actions.length, 1);
    assert.equal(actions[0].name, 'create_chapter');
    const before = (await api('GET', '/api/books/' + fixture.bookId + '/chapters')).chapters.length;
    await api('POST', '/api/books/' + fixture.bookId + '/chat-actions/' + actions[0].id + '/confirm', { approve: false });
    const resumed = await writing({ resumeActionId: actions[0].id, chapterId: fixture.old.id });
    record.resumeEvents = resumed;
    assert.ok(!resumed.some(event => event.type === 'action'), '拒绝后重复发起写操作');
    assert.equal((await api('GET', '/api/books/' + fixture.bookId + '/chapters')).chapters.length, before);
    const final = done(resumed);
    assert.ok(final.run.status === 'finished' || (final.run.status === 'paused' && final.run.reason === 'action_rejected'), JSON.stringify(final.run));
    assert.match(final.content, /拒绝|取消|未执行|未创建|不再/);
    assert.ok(!/已(?:自动)?(?:发起|提交)[^。\n]{0,30}确认|等待(?:您的?|作者)?确认/.test(final.content), '已拒绝的确认卡不能继续说等待确认');
    return { answer: final.content, run: final.run };
  });
  await run('独立Agent确认即停和拒绝续跑', async record => {
    // S3-02 起 /api/agent/chat 只收 conversation_id + content（客户端 messages 数组被 400
    // CLIENT_HISTORY_REJECTED 拒收，路由 routes/agent.js:114）；续跑历史同样由服务端组装，
    // 因此 resumeHistoryMode 参数保留但不再影响请求（不再存在「客户端历史模式」）。
    const events = await stream('/api/agent/chat', { conversation_id: agentConversationId, content: '请为book_id=' + fixture.bookId + '在现有末卷新建一章，标题自动编号，不要执行其他操作。' });
    record.events = events;
    const final = events.find(event => event.type === 'finish');
    assert.equal(final?.messageMetadata?.run?.status, 'awaiting_confirmation', JSON.stringify(final));
    const confirmation = events.map(event => event.output?.data).find(data => data?.status === 'confirmation_required').confirmation;
    const before = (await api('GET', '/api/books/' + fixture.bookId + '/chapters')).chapters.length;
    await api('POST', '/api/agent/actions/' + confirmation.id + '/confirm', { approve: false, conversation_id: agentConversationId });
    const resumed = await stream('/api/agent/actions/' + confirmation.id + '/resume', { conversation_id: agentConversationId });
    record.resumeEvents = resumed;
    record.resumeHistoryMode = 'server-side';
    assert.ok(!resumed.some(event => event.output?.data?.status === 'confirmation_required'), '拒绝后重复发起写操作');
    assert.equal((await api('GET', '/api/books/' + fixture.bookId + '/chapters')).chapters.length, before);
    const resumeFinal = resumed.find(event => event.type === 'finish');
    const resumeRun = resumeFinal?.messageMetadata?.run;
    assert.ok(resumeRun?.status === 'finished' || (resumeRun?.status === 'paused' && resumeRun.reason === 'action_rejected'), JSON.stringify(resumeRun));
    assert.match(resumeFinal.messageMetadata.finalContent, /拒绝|取消|未执行|未创建|不再/, '拒绝续跑必须如实说明已拒绝或未执行：' + resumeFinal.messageMetadata.finalContent);
    assert.ok(!/已(?:自动)?(?:发起|提交)[^。\n]{0,30}确认|等待(?:您的?|作者)?确认/.test(resumeFinal.messageMetadata.finalContent), '已拒绝的确认卡不能继续说等待确认');
    return { answer: resumeFinal.messageMetadata.finalContent };
  });
  await run('单独复验扳手来源事实与关键词', async record => {
    const events = await writing({ chapterId: fixture.old.id, content: '只根据当前章回答：周宁的扳手是谁留下的？请用包含“扳手”的完整一句话回答，不修改数据。' });
    record.events = events;
    const final = done(events);
    assert.ok(final.content.includes('父亲') && final.content.includes('扳手'), final.content);
    return { answer: final.content };
  });
}

main().catch(error => { console.error('FATAL ' + error.message); process.exitCode = 1; }).finally(async () => {
  for (const bookId of books) { try { await api('DELETE', '/api/books/' + bookId); } catch (error) { console.error('CLEANUP ' + error.message); } }
  const passed = results.filter(result => result.pass).length;
  console.log('RESULT ' + passed + '/' + results.length + ' passed; selected model scenarios are not skipped');
  if (passed !== results.length) process.exitCode = 1;
});
