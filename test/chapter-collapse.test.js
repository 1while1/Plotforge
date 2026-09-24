// 分卷折叠状态回归（2026-09-11 实测缺陷：折叠好的卷一新建章节就自动展开）。
// 根因：折叠态只存在于 DOM，而 book-chapters.loadChapters 整表重建 innerHTML，
// 它有 15 个调用点（新建/删除/重命名章节、切章、保存与自动保存、AI 写完刷新……）。
// 修复：状态提到 public/chapter-collapse.js 的按书 store，渲染时回放。
// 本测试钉住 store 的语义（含按书隔离与原型键陷阱）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../public/chapter-collapse');

test('折叠状态可设置/读取/取消，并支持切换', () => {
  const store = createStore();
  assert.equal(store.isCollapsed(3, 2), false, '默认展开');
  store.setCollapsed(3, 2, true);
  assert.equal(store.isCollapsed(3, 2), true);
  store.setCollapsed(3, 2, false);
  assert.equal(store.isCollapsed(3, 2), false, '取消折叠');

  assert.equal(store.toggle(3, 2), true, 'toggle 返回切换后的状态');
  assert.equal(store.isCollapsed(3, 2), true);
  assert.equal(store.toggle(3, 2), false);
  assert.equal(store.isCollapsed(3, 2), false);

  store.setCollapsed(3, 2, true);
  store.expand(3, 2);
  assert.equal(store.isCollapsed(3, 2), false, 'expand 强制展开');
});

test('折叠状态按书隔离：同一卷 id 在不同书互不影响', () => {
  const store = createStore();
  store.setCollapsed(3, 2, true);
  assert.equal(store.isCollapsed(3, 2), true);
  assert.equal(store.isCollapsed(2, 2), false, '另一本书的同 id 卷不受影响');
  assert.deepEqual(store.collapsedIds(3), ['2']);
  assert.deepEqual(store.collapsedIds(2), []);
});

test('卷 id 字符串与数字等价，不因类型不同丢状态', () => {
  const store = createStore();
  store.setCollapsed(3, '2', true);
  assert.equal(store.isCollapsed(3, 2), true, '渲染用数字 id、事件用字符串 id 都能命中');
  store.setCollapsed(3, 2, false);
  assert.equal(store.isCollapsed(3, '2'), false);
});

test('原型键不会造成幻影折叠（constructor/toString 等）', () => {
  const store = createStore();
  assert.equal(store.isCollapsed(3, 'constructor'), false, '普通对象字面量在这里会误报 true');
  assert.equal(store.isCollapsed(3, 'toString'), false);
  store.setCollapsed(3, 'constructor', true);
  assert.equal(store.isCollapsed(3, 'constructor'), true, '真实折叠仍要生效');
  assert.equal(store.isCollapsed(3, 'toString'), false, '不相干的键不受污染');
});

test('无效 bookId/volumeId 不写不炸', () => {
  const store = createStore();
  assert.doesNotThrow(() => store.setCollapsed(null, 2, true));
  assert.doesNotThrow(() => store.setCollapsed(3, undefined, true));
  assert.equal(store.isCollapsed(null, 2), false);
  assert.equal(store.isCollapsed(3, undefined), false);
  assert.deepEqual(store.collapsedIds(null), []);
});

// ---------------- localStorage 持久化（刷新后仍记得折叠） ----------------
function fakeStorage(initial) {
  const data = { ...(initial || {}) };
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
  };
}

test('折叠状态持久化：同一 store 重新创建（模拟刷新）后仍记得', () => {
  const storage = fakeStorage();
  const first = createStore({ storage });
  first.setCollapsed(3, 2, true);
  first.setCollapsed(3, 4, true);
  assert.deepEqual(first.collapsedIds(3), ['2', '4']);
  assert.equal(storage.data['novel-collapse:3'], '["2","4"]', '写入 localStorage');

  // 新 store = 刷新页面后重新加载脚本
  const reloaded = createStore({ storage });
  assert.equal(reloaded.isCollapsed(3, 2), true);
  assert.equal(reloaded.isCollapsed(3, 4), true);
  assert.equal(reloaded.isCollapsed(3, 3), false, '未折叠的卷仍为展开');
  assert.equal(reloaded.isCollapsed(2, 2), false, '其他书不受污染');
});

test('展开后清除持久化记录，不留脏数据', () => {
  const storage = fakeStorage();
  const store = createStore({ storage });
  store.setCollapsed(3, 2, true);
  assert.ok(storage.data['novel-collapse:3']);
  store.setCollapsed(3, 2, false);
  assert.equal(storage.data['novel-collapse:3'], undefined, '全部展开后删除键');
  const reloaded = createStore({ storage });
  assert.deepEqual(reloaded.collapsedIds(3), []);
});

test('持久化数据损坏 / 类型不符 / 存储不可用时退化为内存态，不抛错', () => {
  // 坏 JSON
  const broken = createStore({ storage: fakeStorage({ 'novel-collapse:3': '{不是数组' }) });
  assert.deepEqual(broken.collapsedIds(3), []);
  assert.doesNotThrow(() => broken.setCollapsed(3, 2, true));
  assert.equal(broken.isCollapsed(3, 2), true, '坏数据不影响后续写入');

  // 合法 JSON 但非数组
  const notArray = createStore({ storage: fakeStorage({ 'novel-collapse:3': '{"2":true}' }) });
  assert.deepEqual(notArray.collapsedIds(3), []);

  // 存储对象本身就抛错（隐私模式）
  const throwing = createStore({
    storage: {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    },
  });
  assert.doesNotThrow(() => throwing.setCollapsed(3, 2, true));
  assert.equal(throwing.isCollapsed(3, 2), true, '内存态仍然正确');

  // 完全不传 storage（Node 环境）
  const noStorage = createStore({ storage: null });
  noStorage.setCollapsed(3, 2, true);
  assert.equal(noStorage.isCollapsed(3, 2), true);
});

test('持久化只按书取键，不串其他书的记录', () => {
  const storage = fakeStorage({ 'novel-collapse:2': '["1"]' });
  const store = createStore({ storage });
  assert.equal(store.isCollapsed(3, 1), false, '读的是本书的键，不是别书的');
  assert.equal(store.isCollapsed(2, 1), true, '本书记录正确恢复');
});
