// 分卷折叠状态（2026-09-11 实测缺陷修复）：折叠此前只存在于 DOM——卷行 class 加章节行内联
// display:none。但 book-chapters.loadChapters 每次都整表重建 innerHTML，而它有 15 个调用点
// （新建/删除/重命名章节、切章、保存与 3 秒自动保存、AI 写完刷新、大纲页刷新……），
// 于是「折叠好的卷，一新建章节就自动展开」，任何刷新都会重置。
// 本模块把状态从 DOM 提出来按书存放，渲染时回放；抽成独立工厂是为了可单测（同 character-relations）。
// 另按项目既有惯例（阅读页主题/字号、助手页会话）持久化到 localStorage，刷新后仍记得。
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ChapterCollapse = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var PREFIX = 'novel-collapse:';

  function detectStorage() {
    try {
      // 隐私模式/禁用存储时访问 localStorage 会抛错——退回纯内存态
      return (typeof window !== 'undefined' && window.localStorage) || null;
    } catch (e) {
      return null;
    }
  }

  // 无原型表：卷 id 来自用户数据，用 {} 时 "constructor" 之类的键会读到原型上的值，
  // 表现为「某卷凭空是折叠的」。
  function newMap() { return Object.create(null); }

  function createStore(options) {
    options = options || {};
    var storage = options.storage !== undefined ? options.storage : detectStorage();
    var prefix = options.prefix || PREFIX;
    var byBook = newMap();
    var hydrated = newMap();

    function bucket(bookId) {
      var key = String(bookId);
      if (!byBook[key]) byBook[key] = newMap();
      return byBook[key];
    }

    // 首次访问某本书时从其持久化记录恢复；坏数据/不可用一律忽略，退化为内存态
    function hydrate(bookId) {
      var key = String(bookId);
      var map = bucket(bookId);
      if (hydrated[key]) return;
      hydrated[key] = true;
      if (!storage) return;
      try {
        var raw = storage.getItem(prefix + key);
        if (!raw) return;
        var ids = JSON.parse(raw);
        if (!Array.isArray(ids)) return;
        for (var i = 0; i < ids.length; i++) {
          if (ids[i] !== null && ids[i] !== undefined) map[String(ids[i])] = true;
        }
      } catch (e) { /* 坏 JSON 或存储不可用：忽略 */ }
    }

    function persist(bookId) {
      if (!storage) return;
      try {
        var ids = [];
        var map = bucket(bookId);
        for (var k in map) {
          if (map[k] === true) ids.push(k);
        }
        ids.sort();
        if (ids.length) storage.setItem(prefix + String(bookId), JSON.stringify(ids));
        else storage.removeItem(prefix + String(bookId));
      } catch (e) { /* 配额/不可用：内存态仍然正确 */ }
    }

    function valid(bookId, volumeId) {
      return bookId !== null && bookId !== undefined && volumeId !== null && volumeId !== undefined;
    }

    function isCollapsed(bookId, volumeId) {
      if (!valid(bookId, volumeId)) return false;
      hydrate(bookId);
      return bucket(bookId)[String(volumeId)] === true;
    }

    function setCollapsed(bookId, volumeId, collapsed) {
      if (!valid(bookId, volumeId)) return;
      hydrate(bookId);
      var map = bucket(bookId);
      if (collapsed) map[String(volumeId)] = true;
      else delete map[String(volumeId)];
      persist(bookId);
    }

    // 返回切换后的折叠态，调用方据此更新 DOM
    function toggle(bookId, volumeId) {
      var next = !isCollapsed(bookId, volumeId);
      setCollapsed(bookId, volumeId, next);
      return next;
    }

    function expand(bookId, volumeId) {
      setCollapsed(bookId, volumeId, false);
    }

    // 已折叠的卷 id 列表（稳定顺序，便于测试与调试）
    function collapsedIds(bookId) {
      if (bookId === null || bookId === undefined) return [];
      hydrate(bookId);
      var ids = [];
      var map = bucket(bookId);
      for (var k in map) {
        if (map[k] === true) ids.push(k);
      }
      return ids.sort();
    }

    return {
      isCollapsed: isCollapsed,
      setCollapsed: setCollapsed,
      toggle: toggle,
      expand: expand,
      collapsedIds: collapsedIds,
    };
  }

  return { createStore: createStore };
});
