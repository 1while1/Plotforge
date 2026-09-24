// S1-06/C05 前端回归：回收站弹窗请求的 URL 必须是 /api/books/:id/chapter-recycle。
// 起因：初版实现误拼 basePath()+'/chapter-recycle'（= /chapters/chapter-recycle），
// 被「GET /chapters/:id」路由当成章节名吃掉，冒烟实测弹窗显示 404「章节不存在」。
// 此处以 VM fixture 钉住真实前端文件里的 URL 行为，防同类回归。
const test = require('node:test');
const assert = require('node:assert/strict');
const { editorFixture } = require('./helpers/editor-vm.js');

test('回收站弹窗请求书级 /chapter-recycle 路由并渲染清单', async () => {
  const f = editorFixture();
  const calls = [];
  f.App.api = async (method, route, body) => {
    calls.push({ method, route, body });
    return { items: [{ id: 3, chapter_id: 2, title: '第2章', chars: 13, versions: 2, volume_title: '第一卷', deleted_at: 1695264000000 }] };
  };
  f.node('btn-chapter-recycle').onclick();
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1, '开弹窗只发一次清单请求');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].route, '/api/books/1/chapter-recycle', '回收站是书级路由，不在 /chapters 之下');
  const html = f.node('chapter-recycle-list').innerHTML;
  assert.match(html, /第2章/);
  assert.match(html, /data-restore="3"/);
});

test('清单点恢复：POST 到书级 restore 路由并携带回收记录 id', async () => {
  const f = editorFixture();
  const calls = [];
  f.App.api = async (method, route, body) => {
    calls.push({ method, route, body });
    if (method === 'GET') return { items: [{ id: 3, chapter_id: 2, title: '第2章', chars: 13, versions: 1, deleted_at: 1695264000000 }] };
    return { chapter: { id: 9, title: '第2章', revision: 2 }, reviewItems: [] };
  };
  f.node('btn-chapter-recycle').onclick();
  await new Promise(r => setImmediate(r));
  const box = f.node('chapter-recycle-list');
  box.onclick({ target: { closest: sel => (sel === '[data-restore]' ? { dataset: { restore: '3' } } : null) } });
  await new Promise(r => setImmediate(r));
  const post = calls.find(c => c.method === 'POST');
  assert.ok(post, '点恢复必须发 POST');
  assert.equal(post.route, '/api/books/1/chapter-recycle/3/restore', 'restore 也走书级路由');
});
