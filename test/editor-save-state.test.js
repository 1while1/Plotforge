// S1-04/C02 前端回归：保存快照不得把「保存期间的新输入」标成已保存。
// 标干净必须同时满足：同一书章、持久化成功（200+persistence.durable）、
// 编辑代数与提交快照一致（期间无新输入）。请求期间的新输入保持脏并排队下一笔。
// fixture 复用 test/helpers/editor-vm.js（真实前端文件 + 最小 DOM/App 桩）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { editorFixture } = require('./helpers/editor-vm');

function openChapterAtRev1(f) {
  f.App.api = async () => ({ chapter: { id: 1, title: '第1章', content: '原文', beat: '', revision: 1 } });
  return f.BookPage.selectChapter(1);
}

test('保存期间继续输入：PUT 完成后新输入仍是脏的，未被标干净也未被响应覆盖', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  let resolvePut;
  const puts = [];
  f.App.api = async (method, route, body) => {
    if (method === 'PUT') {
      puts.push(body);
      return new Promise(resolve => { resolvePut = resolve; });
    }
    return { chapter: { id: 1, revision: 2 } };
  };
  f.node('chapter-content').value = '第一次编辑';
  f.node('chapter-content').listeners.input();
  const saving = f.BookPage.saveChapter(true); // 提交「第一次编辑」，PUT 挂起
  // 保存进行中继续输入（C02 反例场景）
  f.node('chapter-content').value = '第一次编辑+保存期间的新文字';
  f.node('chapter-content').listeners.input();
  resolvePut({ chapter: { id: 1, revision: 2 }, persistence: { durable: true, pending: false, code: null } });
  assert.equal(await saving, true, '第一笔本身保存成功');

  assert.equal(f.dirty(), true, '保存期间的新输入不得被标干净（离开告警仍在）');
  assert.equal(f.node('chapter-content').value, '第一次编辑+保存期间的新文字', '不得用服务器响应整段替换编辑器内容');

  // 下一笔保存：携带服务端返回的新 revision 与最新内容，不制造永久冲突
  f.App.api = async (method, route, body) => {
    if (method === 'PUT') { puts.push(body); return { chapter: { id: 1, revision: 3 } }; }
    return { chapter: { id: 1, revision: 3 } };
  };
  assert.equal(await f.BookPage.saveChapter(true), true);
  assert.equal(puts[1].content, '第一次编辑+保存期间的新文字', '第二笔提交的是最新输入');
  assert.equal(puts[1].expected_revision, 2, '第二笔以第一笔响应的新 revision 为基准');
  assert.equal(f.dirty(), false, '没有再输入则标干净');
});

test('保存期间改标题：响应到达同样不标干净', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  let resolvePut;
  f.App.api = async (method) => {
    if (method === 'PUT') return new Promise(resolve => { resolvePut = resolve; });
    return { chapter: { id: 1, revision: 2 } };
  };
  f.node('chapter-content').value = '正文编辑';
  f.node('chapter-content').listeners.input();
  const saving = f.BookPage.saveChapter(true);
  f.node('chapter-title-input').value = '改名后的标题';
  f.node('chapter-title-input').listeners.input();
  resolvePut({ chapter: { id: 1, revision: 2 } });
  assert.equal(await saving, true);
  assert.equal(f.dirty(), true, '标题变更发生在保存期间，不得标干净');
  assert.equal(f.node('chapter-title-input').value, '改名后的标题', '本地标题不被覆盖');
});

test('保存期间切走章节：晚到的成功响应不动新上下文的编辑状态', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  let resolvePut;
  f.App.api = async (method) => {
    if (method === 'PUT') return new Promise(resolve => { resolvePut = resolve; });
    return { chapter: { id: 1, revision: 2 } };
  };
  f.node('chapter-content').value = '旧章的编辑';
  f.node('chapter-content').listeners.input();
  const saving = f.BookPage.saveChapter(true);
  // 保存期间作者切到另一章（真实流程会重载编辑器与基线）
  f.App.state.currentChapterId = 2;
  f.node('chapter-content').value = '新章的正文';
  resolvePut({ chapter: { id: 1, revision: 2 } });
  assert.equal(await saving, true, '旧章那笔本身成功');
  assert.equal(f.App.state.currentChapterId, 2, '晚到响应不把作者拽回旧章');
});

test('applied=true 但未落盘（503 PERSISTENCE_PENDING）：不标干净，刷新版本快照避免下一笔假冲突', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  const calls = [];
  f.App.api = async (method, route, body) => {
    calls.push({ m: method, b: body });
    if (method === 'PUT') {
      const err = new Error('写入已应用但暂未落盘');
      err.code = 'PERSISTENCE_PENDING';
      err.status = 503;
      throw err;
    }
    // 拒写后重读：服务器内存态已应用并推进 revision（S1-01 契约）
    return { chapter: { id: 1, title: '第1章', content: '第一次编辑', beat: '', revision: 2, locked: 0, relock_pending: 0 } };
  };
  f.node('chapter-content').value = '第一次编辑';
  f.node('chapter-content').listeners.input();
  assert.equal(await f.BookPage.saveChapter(true), false, '未落盘按未完成处理');
  assert.equal(f.dirty(), true, '未持久化不得标干净');
  const gets = calls.filter(c => c.m === 'GET');
  assert.equal(gets.length >= 1, true, '拒写后重读了章节以刷新版本快照');

  // 磁盘自愈后的下一笔：以刷新后的 revision 提交，不产生假 409
  const puts = [];
  f.App.api = async (method, route, body) => {
    if (method === 'PUT') { puts.push(body); return { chapter: { id: 1, revision: 3 }, persistence: { durable: true } }; }
    return { chapter: { id: 1, revision: 3 } };
  };
  f.node('chapter-content').value = '第一次编辑+续写';
  f.node('chapter-content').listeners.input();
  assert.equal(await f.BookPage.saveChapter(true), true);
  assert.equal(puts[0].expected_revision, 2, '下一笔携带拒写期间推进后的版本');
  assert.equal(f.dirty(), false, '落盘成功且无新输入才标干净');
});

test('成功响应携带 persistence.durable=false：同样不标干净', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  f.App.api = async (method) => {
    if (method === 'PUT') return { chapter: { id: 1, revision: 2 }, persistence: { durable: false, pending: true, code: 'PERSISTENCE_PENDING' } };
    return { chapter: { id: 1, revision: 2 } };
  };
  f.node('chapter-content').value = '编辑';
  f.node('chapter-content').listeners.input();
  assert.equal(await f.BookPage.saveChapter(true), true, 'HTTP 200 路径按成功返回');
  assert.equal(f.dirty(), true, 'durable=false 不满足标干净三条件');
});
