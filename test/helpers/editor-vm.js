// 写作页编辑器 VM fixture：沿用审查反例（docs/report/20260921_全系统闭环审查/
// 01-隔离反例.cjs 的 editorFixture）的手法——最小 DOM/App 桩 + vm 跑真实前端文件，
// 钉住行为而非实现。S1-03c/S1-04 的编辑器回归共用此份。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');

function editorFixture() {
  const nodes = new Map(), events = {};
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', dataset: {}, style: {}, listeners: {}, innerHTML: '',
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, fn) { this.listeners[name] = fn; },
    });
    return nodes.get(id);
  }
  // chapter-conflict.js 会把动作按钮挂到 #modal-body .conflict-actions 上
  const conflictBox = { onclick: null };
  let modalOpts = null;
  const App = {
    state: { currentBook: { id: 1 }, currentChapterId: null },
    toast() {},
    escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    },
    openModal(opts) { modalOpts = opts; },
    closeModal() {},
    api: async () => ({}),
  };
  const win = { App, addEventListener(name, fn) { events[name] = fn; } };
  const context = {
    window: win, App,
    document: {
      getElementById: node,
      querySelector(sel) { return sel.indexOf('conflict-actions') >= 0 ? conflictBox : null; },
      querySelectorAll: () => [],
    },
    console, setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
    navigator: {}, location: { hash: '' },
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/chapter-collapse.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/chapter-conflict.js'), 'utf8'), context);
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public/book-chapters.js'), 'utf8'), context);
  win.BookPage.loadChapters = async () => {};
  win.BookPage.bindChapterEvents(); // input 脏检查监听在编辑器/标题/节拍框上，随事件绑定
  return {
    App, BookPage: win.BookPage, node, events, conflictBox,
    modalOpts: () => modalOpts,
    clickConflict(act) {
      conflictBox.onclick({ target: { closest: sel => (sel === '[data-act]' ? { dataset: { act } } : null) } });
    },
    // 离开告警是否仍存在（beforeunload 是否被阻止）
    dirty() {
      let prevented = false;
      events.beforeunload({ preventDefault() { prevented = true; } });
      return prevented;
    },
  };
}

module.exports = { editorFixture };
