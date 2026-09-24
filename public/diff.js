// 段落级对齐 + 段内字级高亮的 diff 引擎与润色对比视图
(function () {
  'use strict';

  // ---------- 工具 ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 按行（空行忽略）切分段落
  function splitLines(text) {
    return String(text).split(/\n+/).map(s => s.trim()).filter(s => s.length > 0);
  }

  // 经典 LCS（行级），返回对齐操作序列
  function lcsAlign(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { ops.push({ type: 'same', oldLine: a[i], newLine: b[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', oldLine: a[i] }); i++; }
      else { ops.push({ type: 'ins', newLine: b[j] }); j++; }
    }
    while (i < m) { ops.push({ type: 'del', oldLine: a[i] }); i++; }
    while (j < n) { ops.push({ type: 'ins', newLine: b[j] }); j++; }
    return ops;
  }

  // 字级 LCS，返回 [{text, kind}] kind: same/del/ins
  function charDiff(oldStr, newStr) {
    const a = [...oldStr], b = [...newStr];
    const m = a.length, n = b.length;
    // 超长段落退化为整段替换，避免 O(m*n) 爆内存
    if (m * n > 40000) {
      return [{ text: oldStr, kind: 'del' }, { text: newStr, kind: 'ins' }];
    }
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const parts = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { parts.push({ text: a[i], kind: 'same' }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { parts.push({ text: a[i], kind: 'del' }); i++; }
      else { parts.push({ text: b[j], kind: 'ins' }); j++; }
    }
    while (i < m) { parts.push({ text: a[i], kind: 'del' }); i++; }
    while (j < n) { parts.push({ text: b[j], kind: 'ins' }); j++; }
    // 合并相邻同类
    const merged = [];
    for (const p of parts) {
      if (merged.length && merged[merged.length - 1].kind === p.kind) merged[merged.length - 1].text += p.text;
      else merged.push({ ...p });
    }
    return merged;
  }

  // ---------- 渲染 ----------
  function renderInline(parts, showKind) {
    // showKind: 'del' 视角显示旧行（标删除），'ins' 视角显示新行（标新增）
    return parts.map(p => {
      if (p.kind === 'same') return esc(p.text);
      if (p.kind === 'del') return showKind === 'del' ? `<span class="d-del">${esc(p.text)}</span>` : '';
      return showKind === 'ins' ? `<span class="d-ins">${esc(p.text)}</span>` : '';
    }).join('');
  }

  function renderDiff(oldText, newText) {
    const ops = lcsAlign(splitLines(oldText), splitLines(newText));
    const html = [];
    let i = 0;
    while (i < ops.length) {
      const op = ops[i];
      if (op.type === 'same') {
        html.push(`<p class="d-same">${esc(op.oldLine)}</p>`);
        i++;
        continue;
      }
      // 收集连续 del/ins 组成变更块并配对
      const dels = [], inss = [];
      while (i < ops.length && ops[i].type !== 'same') {
        if (ops[i].type === 'del') dels.push(ops[i].oldLine);
        else inss.push(ops[i].newLine);
        i++;
      }
      const pairs = Math.min(dels.length, inss.length);
      for (let k = 0; k < pairs; k++) {
        const parts = charDiff(dels[k], inss[k]);
        html.push(`<p class="d-old">${renderInline(parts, 'del')}</p>`);
        html.push(`<p class="d-new">${renderInline(parts, 'ins')}</p>`);
      }
      for (let k = pairs; k < dels.length; k++) html.push(`<p class="d-old">${esc(dels[k])}</p>`);
      for (let k = pairs; k < inss.length; k++) html.push(`<p class="d-new">${esc(inss[k])}</p>`);
    }
    return html.join('');
  }

  // ---------- 对比视图控制器 ----------
  let acceptHandler = null;

  function show({ scope, original, polished, onAccept }) {
    const view = document.getElementById('diff-view');
    const body = document.getElementById('diff-body');
    if (!view || !body) return;
    document.getElementById('diff-scope').textContent = scope === 'selection' ? '· 选中段落' : '· 整章';
    body.innerHTML = renderDiff(original, polished);
    view.classList.remove('hidden');
    acceptHandler = () => onAccept(polished);
  }

  function hide() {
    const view = document.getElementById('diff-view');
    if (view) view.classList.add('hidden');
    acceptHandler = null;
  }

  function bind() {
    const accept = document.getElementById('btn-diff-accept');
    const reject = document.getElementById('btn-diff-reject');
    if (accept) accept.onclick = () => { const h = acceptHandler; hide(); if (h) h(); };
    if (reject) reject.onclick = hide;
  }

  window.DiffView = { show, hide, bind, _renderDiff: renderDiff };
})();
