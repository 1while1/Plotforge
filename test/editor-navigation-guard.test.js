// S1-05/C03 前端回归：保存失败不得静默离开。切章走离开闸门——保存成功（含期间
// 无新输入）才放行；失败/保存期间新输入则停留原章、草稿原样，弹「重试保存/留在
// 本章/明确放弃」三选一。放弃必须作者点击，错误绝不隐式当作放弃。
// fixture 复用 test/helpers/editor-vm.js（真实前端文件 + 最小 DOM/App 桩）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { editorFixture } = require('./helpers/editor-vm');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function openChapterAtRev1(f) {
  f.App.api = async () => ({ chapter: { id: 1, title: '第1章', content: '原文', beat: '', revision: 1 } });
  return f.BookPage.selectChapter(1);
}

test('保存失败拦下切章：留在原章、草稿原样、仍为脏，不发第二笔', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  const puts = [];
  f.App.api = async (method, route, body) => {
    if (method === 'PUT') { puts.push(body); throw new Error('AUDIT_NETWORK_FAILURE'); }
    return { chapter: { id: 2, title: '第2章', content: '第二章正文', beat: '', revision: 1 } };
  };
  f.node('chapter-content').value = '未保存的手写草稿';
  f.node('chapter-content').listeners.input();
  await f.BookPage.selectChapter(2);

  assert.equal(f.App.state.currentChapterId, 1, '保存失败不得切走（C03）');
  assert.equal(f.node('chapter-content').value, '未保存的手写草稿', '草稿留在编辑器，不被清空');
  assert.equal(f.dirty(), true, '仍为脏，离开告警仍在');
  assert.equal(puts.length, 1, '停留后没有第二笔写入（错误不当放弃也不当重放）');
  const opts = f.modalOpts();
  assert.ok(opts, '三选一弹窗已开');
  assert.equal(opts.title, '有未保存的修改');
});

test('三选一「重试保存并继续」：保存成功后完成切换', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  f.App.api = async (method) => {
    if (method === 'PUT') throw new Error('AUDIT_NETWORK_FAILURE');
    return { chapter: { id: 2, title: '第2章', content: '第二章正文', beat: '', revision: 1 } };
  };
  f.node('chapter-content').value = '要落库的草稿';
  f.node('chapter-content').listeners.input();
  await f.BookPage.selectChapter(2);
  assert.ok(f.modalOpts(), '已拦下');

  // 网络恢复后作者点「重试保存并继续」
  f.App.api = async (method, route, body) => {
    if (method === 'PUT') return { chapter: { id: 1, revision: 2 } };
    return { chapter: { id: 2, title: '第2章', content: '第二章正文', beat: '', revision: 1 } };
  };
  f.clickConflict('retry');
  await tick(); await tick();
  assert.equal(f.App.state.currentChapterId, 2, '重试成功后完成切换');
  assert.equal(f.node('chapter-content').value, '第二章正文', '编辑器载入目标章');
  assert.equal(f.dirty(), false, '落库后干净');
});

test('三选一「放弃修改并继续」：明确点击才放行，放弃后不再尝试保存', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  const puts = [];
  f.App.api = async (method, route, body) => {
    if (method === 'PUT') { puts.push(body); throw new Error('AUDIT_NETWORK_FAILURE'); }
    return { chapter: { id: 2, title: '第2章', content: '第二章正文', beat: '', revision: 1 } };
  };
  f.node('chapter-content').value = '将被明确放弃的草稿';
  f.node('chapter-content').listeners.input();
  await f.BookPage.selectChapter(2);
  assert.equal(puts.length, 1);

  f.clickConflict('discard');
  await tick(); await tick();
  assert.equal(f.App.state.currentChapterId, 2, '作者明确放弃后切换');
  assert.equal(f.dirty(), false, '脏状态被清除');
  assert.equal(puts.length, 1, '放弃路径不再发起保存');
});

test('保存成功但期间又有新输入（S1-04 代数）：同样拦下', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  let resolvePut;
  f.App.api = async (method) => {
    if (method === 'PUT') return new Promise(resolve => { resolvePut = resolve; });
    return { chapter: { id: 2, title: '第2章', content: '第二章正文', beat: '', revision: 1 } };
  };
  f.node('chapter-content').value = '第一段草稿';
  f.node('chapter-content').listeners.input();
  const switching = f.BookPage.selectChapter(2);
  // 闸门保存进行中继续输入
  f.node('chapter-content').value = '第一段草稿+闸门期间新输入';
  f.node('chapter-content').listeners.input();
  resolvePut({ chapter: { id: 1, revision: 2 } });
  await switching;

  assert.equal(f.App.state.currentChapterId, 1, '新输入未落库不得切走');
  assert.equal(f.node('chapter-content').value, '第一段草稿+闸门期间新输入', '内容原样');
  assert.equal(f.dirty(), true, '仍为脏');
  assert.ok(f.modalOpts(), '三选一弹窗已开');
});

test('leaveGuard/hasUnsavedChanges/clearUnsaved：app.js 切书闸门消费的 API 语义', async () => {
  const f = editorFixture();
  await openChapterAtRev1(f);
  assert.equal(f.BookPage.hasUnsavedChanges(), false, '干净状态不拦');
  assert.equal(await f.BookPage.leaveGuard({}), true, '干净直接放行，不弹窗');
  assert.equal(f.modalOpts(), null, '未弹窗');

  f.App.api = async (method) => {
    if (method === 'PUT') throw new Error('AUDIT_NETWORK_FAILURE');
    return { chapter: { id: 1, revision: 1 } };
  };
  f.node('chapter-content').value = '切书前的草稿';
  f.node('chapter-content').listeners.input();
  assert.equal(f.BookPage.hasUnsavedChanges(), true);
  assert.equal(await f.BookPage.leaveGuard({ onRetry() {}, onDiscard() {} }), false, '保存失败拦下');
  assert.ok(f.modalOpts(), '弹窗已开');

  // 作者明确放弃 → clearUnsaved 放行
  f.BookPage.clearUnsaved();
  assert.equal(f.BookPage.hasUnsavedChanges(), false, '明确放弃后不再视为未保存');
  assert.equal(await f.BookPage.leaveGuard({}), true, '清脏后放行');
});
