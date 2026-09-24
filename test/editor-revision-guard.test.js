// S1-03/C04-B 前端回归：编辑器保存必须携带服务端 revision；409 冲突保留本地稿、
// 弹显式二选一且绝不自动重发；428（快照缺版本）按「先读后写」协议重读一次再提交。
// 手法沿用审查反例的 VM fixture（docs/report/20260921_全系统闭环审查/01-隔离反例.cjs
// 的 editorFixture）：最小 DOM/App 桩 + vm 跑真实前端文件，钉住行为而非实现。
const test = require('node:test');
const assert = require('node:assert/strict');
const { editorFixture } = require('./helpers/editor-vm');

test('保存请求携带服务端 revision，成功后以服务端新版本为下一次基准', async () => {
  const f = editorFixture();
  f.App.api = async () => ({ chapter: { id: 1, title: '第1章', content: '原文', beat: '', revision: 1 } });
  await f.BookPage.selectChapter(1);
  const payloads = [];
  f.App.api = async (method, route, body) => {
    payloads.push(body);
    return { chapter: { id: 1, revision: 2 } };
  };
  f.node('chapter-content').value = '第一次编辑';
  f.node('chapter-content').listeners.input();
  assert.equal(await f.BookPage.saveChapter(true), true);
  assert.equal(payloads[0].expected_revision, 1, '保存必须携带打开章节时的服务端版本');

  f.node('chapter-content').value = '第二次编辑';
  f.node('chapter-content').listeners.input();
  await f.BookPage.saveChapter(true);
  assert.equal(payloads[1].expected_revision, 2, '下一次保存以服务端返回的新版本为基准');
});

test('409 冲突：本地稿留在编辑器、不清脏基线、绝不自动重发、弹显式二选一', async () => {
  const f = editorFixture();
  f.App.api = async () => ({ chapter: { id: 1, title: '第1章', content: '原文', beat: '', revision: 3 } });
  await f.BookPage.selectChapter(1);
  f.node('chapter-content').value = '本地手改稿';
  f.node('chapter-content').listeners.input();
  const calls = [];
  f.App.api = async (method, route) => {
    calls.push(method + ' ' + route);
    if (method === 'PUT') {
      const err = new Error('章节已被修改（期望 3，当前 4）');
      err.code = 'CHAPTER_CONFLICT';
      throw err;
    }
    return { chapter: { id: 1, title: '他窗口改过', content: '服务端正文', beat: '', revision: 4, updated_at: '2026-09-21 10:00:00' } };
  };
  assert.equal(await f.BookPage.saveChapter(true), false, '冲突保存返回失败');
  assert.equal(f.node('chapter-content').value, '本地手改稿', '本地稿不被服务端内容覆盖');
  let prevented = false;
  f.events.beforeunload({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true, '冲突后仍视为有未保存修改（不清脏基线）');
  assert.equal(calls.filter(c => c.startsWith('PUT')).length, 1, '绝不自动以新 revision 重发旧全文');
  const opts = f.modalOpts();
  assert.ok(opts, '冲突对话框已弹出');
  assert.equal(opts.title, '章节已在别处被修改');
  assert.ok(String(opts.bodyHTML).indexOf('4') >= 0, '展示服务端已更新（含版本信息）');
});

test('冲突对话框选择重载：回填服务端最新版，后续保存以服务端版本为基准', async () => {
  const f = editorFixture();
  f.App.api = async () => ({ chapter: { id: 1, title: '第1章', content: '原文', beat: '', revision: 3 } });
  await f.BookPage.selectChapter(1);
  f.node('chapter-content').value = '本地手改稿';
  f.node('chapter-content').listeners.input();
  f.App.api = async (method) => {
    if (method === 'PUT') {
      const err = new Error('章节已被修改');
      err.code = 'CHAPTER_CONFLICT';
      throw err;
    }
    return { chapter: { id: 1, title: '第1章', content: '服务端正文', beat: '新节拍', revision: 4, locked: 0, relock_pending: 0 } };
  };
  await f.BookPage.saveChapter(true);
  assert.ok(f.modalOpts(), '对话框已弹出');

  // 模拟作者点击「放弃本地稿，重载服务端版本」
  f.clickConflict('reload');
  assert.equal(f.node('chapter-content').value, '服务端正文', '编辑器回填服务端内容');
  assert.equal(f.node('chapter-beat').value, '新节拍', '随章节快照一并回填');

  const payloads = [];
  f.App.api = async (method, route, body) => {
    payloads.push(body);
    return { chapter: { id: 1, revision: 5 } };
  };
  f.node('chapter-content').value = '基于服务端版本的继续编辑';
  f.node('chapter-content').listeners.input();
  await f.BookPage.saveChapter(true);
  assert.equal(payloads[0].expected_revision, 4, '重载后以服务端版本为新基准');
});

test('保存单飞：手动保存与自动保存并发时只发一次 PUT，不双发同一旧版本', async () => {
  const f = editorFixture();
  f.App.api = async () => ({ chapter: { id: 1, title: '第1章', content: '原文', beat: '', revision: 1 } });
  await f.BookPage.selectChapter(1);
  let resolveFirstPut;
  const puts = [];
  f.App.api = async (method, route, body) => {
    if (method === 'PUT') {
      puts.push(body);
      // 首个 PUT 挂起（手动保存进行中）；并发窗口之后的 PUT 正常返回
      if (resolveFirstPut === undefined) {
        return new Promise(resolve => { resolveFirstPut = resolve; });
      }
      return { chapter: { id: 1, revision: 2 } };
    }
    return { chapter: { id: 1, revision: 2 } };
  };
  f.node('chapter-content').value = '并发输入';
  f.node('chapter-content').listeners.input();
  const first = f.BookPage.saveChapter(true);  // 手动保存，PUT 挂起中
  const second = f.BookPage.saveChapter(true); // 同一窗口到达的 3 秒自动保存
  resolveFirstPut({ chapter: { id: 1, revision: 2 } });
  assert.equal(await first, true);
  assert.equal(await second, true, '并发调用共享同一次飞行，结果一致');
  assert.equal(puts.length, 1, '只发一次 PUT，不双发同一旧版本互相撞 409');

  // 飞行结束后可以正常再次保存
  f.node('chapter-content').value = '后续输入';
  f.node('chapter-content').listeners.input();
  await f.BookPage.saveChapter(true);
  assert.equal(puts.length, 2, '飞行结束不粘连，后续保存照常发出');
});

test('快照缺版本（428）：按「先读后写」协议重读一次再提交，成功后补齐基准', async () => {
  const f = editorFixture();
  // 打开章节时返回体没有 revision（旧形状/异常）：快照为空，PUT 被服务端 428 拒绝
  f.App.api = async () => ({ chapter: { id: 1, title: '第1章', content: '原文', beat: '' } });
  await f.BookPage.selectChapter(1);
  const seq = [];
  f.App.api = async (method, route, body) => {
    seq.push(method);
    if (method === 'PUT') {
      if (!('expected_revision' in body)) {
        const err = new Error('缺少 expectedRevision：请先读取章节当前 revision 再提交修改');
        err.code = 'CHAPTER_REVISION_REQUIRED';
        throw err;
      }
      return { chapter: { id: 1, revision: 7 } };
    }
    return { chapter: { id: 1, title: '第1章', content: '原文', beat: '', revision: 7 } };
  };
  f.node('chapter-content').value = '编辑';
  f.node('chapter-content').listeners.input();
  assert.equal(await f.BookPage.saveChapter(true), true);
  assert.deepEqual(seq, ['PUT', 'GET', 'PUT'], '缺版本时先重读当前 revision 再写，仅一次防御性重试');
});

test('快照缺版本且重读仍失败：不盲写、不静默，作者看到失败提示且本地稿保留', async () => {
  const f = editorFixture();
  f.App.api = async () => ({ chapter: { id: 1, title: '第1章', content: '原文', beat: '' } });
  await f.BookPage.selectChapter(1);
  f.node('chapter-content').value = '本地稿';
  f.node('chapter-content').listeners.input();
  const seq = [];
  f.App.api = async (method) => {
    seq.push(method);
    if (method === 'PUT') {
      const err = new Error('缺少 expectedRevision');
      err.code = 'CHAPTER_REVISION_REQUIRED';
      throw err;
    }
    return { chapter: { id: 1, title: '第1章', content: '原文', beat: '' } }; // 重读仍没有 revision
  };
  assert.equal(await f.BookPage.saveChapter(true), false);
  assert.deepEqual(seq, ['PUT', 'GET', 'GET'], '重读拿不到版本就不再盲写（仅一次 PUT）；后续 GET 是冲突对话拉服务端最新版');
  assert.equal(f.node('chapter-content').value, '本地稿', '本地稿保留');
  const opts = f.modalOpts();
  assert.ok(opts, '走冲突对话提示作者（服务端内容已展示），不静默跳过');
});
