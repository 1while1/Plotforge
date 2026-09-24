// 作家卡页（#/book/:id/cards）—— 作家仓库的卡片管理界面。
//
// 解耦：本页是独立整页 + 独立模块，只调 /api/style-lab/packs*。
// 不改写作页/阅读页的任何逻辑；删掉本文件与 app.js 里的一行路由，系统行为不变（只少一个页面）。
(function () {
  'use strict';

  var App = window.App;
  var Cards = window.Cards = window.Cards || {};

  var S = {
    bookId: null,
    packs: [],
    bindings: { main_id: null, aux_ids: [] },
    chain: [],
    editing: null,   // 正在编辑的卡（含 rules/samples）
    dirty: false,
  };

  function $(id) { return document.getElementById(id); }
  function esc(v) { return App.escapeHtml(v); }

  // ---------- 本书绑定 ----------

  function renderBinding() {
    var box = $('cards-binding');
    if (!box) return;
    var main = S.packs.find(function (p) { return p.id === S.bindings.main_id; });
    var chain = S.chain || [];
    var html = '<div class="binding-row">' +
      '<span class="binding-role">主卡</span>' +
      '<select id="cards-main-select"><option value="">（不指定，用内置通用卡）</option>' +
      S.packs.map(function (p) {
        return '<option value="' + p.id + '"' + (p.id === S.bindings.main_id ? ' selected' : '') +
          '>' + esc(p.name) + (p.builtin ? '（内置）' : '') + '</option>';
      }).join('') +
      '</select></div>';
    html += '<div class="binding-row"><span class="binding-role">辅卡</span><div class="binding-aux">';
    html += S.packs.filter(function (p) { return p.id !== S.bindings.main_id; }).map(function (p) {
      var on = S.bindings.aux_ids.indexOf(p.id) !== -1;
      return '<label class="binding-chip' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" data-aux="' + p.id + '"' + (on ? ' checked' : '') + '>' +
        esc(p.name) + '</label>';
    }).join('');
    html += '</div></div>';
    html += '<p class="field-hint">当前生效：<strong>' +
      (chain.length ? chain.map(function (c) { return esc(c.name); }).join(' + ') : '无（风格层空转）') +
      '</strong>' +
      (S.effectiveSource === 'basic' && !S.bindings.main_id
        ? '<span class="field-hint">（本书未绑定主卡，自动用内置通用卡兜底；选了主卡就按你选的来）</span>' : '') +
      '</p>';
    box.innerHTML = html;

    var mainSel = $('cards-main-select');
    if (mainSel) mainSel.onchange = function () { saveBindings(this.value, S.bindings.aux_ids); };
    box.querySelectorAll('[data-aux]').forEach(function (cb) {
      cb.onchange = function () {
        var id = Number(this.dataset.aux);
        var aux = S.bindings.aux_ids.slice();
        var i = aux.indexOf(id);
        if (this.checked && i === -1) aux.push(id);
        if (!this.checked && i !== -1) aux.splice(i, 1);
        saveBindings(S.bindings.main_id, aux);
      };
    });
  }

  async function saveBindings(mainId, auxIds) {
    try {
      var bindings = [];
      if (mainId) bindings.push({ packId: Number(mainId), role: 'main', sortOrder: 0 });
      (auxIds || []).forEach(function (id, i) {
        bindings.push({ packId: Number(id), role: 'aux', sortOrder: i });
      });
      await App.api('PUT', '/api/style-lab/books/' + S.bookId + '/cards', { bindings: bindings });
      App.toast('已换卡，下一轮对话生效');
      await load();
    } catch (e) { App.toast(e.message); }
  }

  // ---------- 卡片库 ----------

  function renderList() {
    var box = $('cards-list');
    if (!box) return;
    if (!S.packs.length) {
      box.innerHTML = '<p class="empty-hint">还没有卡片。点右上角「新建卡」开始。</p>';
      return;
    }
    box.innerHTML = S.packs.map(function (p) {
      var st = p.stats || {};
      var inChain = (S.chain || []).some(function (c) { return c.id === p.id; });
      return '<div class="card-item' + (inChain ? ' in-chain' : '') + (p.enabled ? '' : ' disabled') + '" data-id="' + p.id + '">' +
        '<div class="card-item-head">' +
        '<span class="card-name">' + esc(p.name) + '</span>' +
        (p.builtin ? '<span class="card-tag">内置</span>' : '') +
        (p.kind === 'imprint' ? '<span class="card-tag">印记</span>' : '') +
        (inChain ? '<span class="card-tag on">生效中</span>' : '') +
        (p.enabled ? '' : '<span class="card-tag off">已停用</span>') +
        '</div>' +
        '<div class="card-item-meta">' + (st.rules || 0) + ' 条规则（' + (st.must || 0) + ' 必守）· ' +
        (st.samples || 0) + ' 段范文' + (p.persona ? ' · 有人设' : ' · 无人设') + '</div>' +
        '<div class="card-item-note">' + esc((p.note || '').slice(0, 80)) + '</div>' +
        '</div>';
    }).join('');
    box.querySelectorAll('.card-item').forEach(function (el) {
      el.onclick = function () { openEditor(Number(this.dataset.id)); };
    });
  }

  // ---------- 注入预览 ----------

  async function loadPreview() {
    try {
      var res = await App.api('GET', '/api/style-lab/packs-preview?book_id=' + encodeURIComponent(S.bookId));
      var meta = $('cards-preview-meta');
      var pre = $('cards-preview');
      if (meta) {
        meta.innerHTML = '来源：<strong>' + esc(res.source) + '</strong> · 卡链：' +
          (res.chain.length ? res.chain.map(function (c) { return esc(c.name); }).join(' + ') : '无') +
          ' · <strong>' + res.chars + '</strong> 字符（' + res.hanzi + ' 汉字） / 预算 ' + res.budget_chars +
          ' · 规则 ' + res.rule_count + ' 条' +
          (res.style_layer_enabled ? '' : ' · <strong class="warn">风格注入已全局关闭</strong>');
      }
      if (pre) pre.textContent = res.text || '（当前无卡生效，风格层不注入任何内容）';
    } catch (e) {
      if ($('cards-preview')) $('cards-preview').textContent = '预览失败：' + e.message;
    }
  }

  async function load() {
    if (!S.bookId) return;
    try {
      var res = await App.api('GET', '/api/style-lab/packs?book_id=' + encodeURIComponent(S.bookId));
      S.packs = res.packs || [];
      S.bindings = {
        main_id: res.bindings && res.bindings.main ? res.bindings.main.id : null,
        aux_ids: res.bindings && res.bindings.aux ? res.bindings.aux.map(function (p) { return p.id; }) : [],
      };
      // 生效卡链取自服务端解析结果（含内置卡兜底），不是「绑定了什么」——
      // 两者不等价：没绑任何卡时生效的是内置通用卡，UI 必须显示真实生效的那张。
      var chainIds = (res.effective && res.effective.chain_ids) || [];
      S.chain = chainIds.map(function (id) {
        return S.packs.find(function (p) { return p.id === id; });
      }).filter(Boolean);
      S.effectiveSource = res.effective ? res.effective.source : 'none';
      renderBinding();
      renderList();
    } catch (e) { App.toast(e.message); }
    loadPreview();
  }

  // ---------- 编辑器 ----------

  // 指纹 textarea <-> 对象：一行一条「键: 值」，空行忽略。
  // 明文格式而非 JSON——作者要手写这个，JSON 的括号引号只会碍事。
  function profileToText(profile) {
    return Object.keys(profile || {}).map(function (k) { return k + ': ' + profile[k]; }).join('\n');
  }
  function textToProfile(text) {
    var out = {};
    String(text || '').split('\n').forEach(function (line) {
      var m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:：]\s*(.+?)\s*$/);
      if (m) out[m[1]] = m[2];
    });
    return out;
  }

  // 分级标签＝「这条规则在提示词里怎么用」，不是「是否进正文额度」。
  // 2026-09-12 起 normal/hint 也**全文注入**（节标题换成「技法参考（按情境判断，不要逐条套用）」），
  // 原先写的「常规（进目录）／提示（进目录）」是被推翻的旧语义，已实测误导作者（会以为正文没进提示词）。
  var SEV_LABEL = { must: '必守（全文注入）', normal: '常规（全文注入·按情境）', hint: '提示（全文注入·方向性）' };

  function sampleRow(s) {
    return '<div class="rule-row" data-sample-id="' + s.id + '">' +
      '<div class="rule-row-head">' +
      '<input class="rule-title" data-f="title" value="' + esc(s.title) + '" placeholder="段名（可空）">' +
      '<span class="rule-src">' + (s.charCount || 0) + ' 字' + (s.indexed ? ' · 已索引' : '') + '</span>' +
      '<button class="btn btn-small btn-ghost" data-del-sample="1" type="button">删除</button>' +
      '</div>' +
      '<textarea class="rule-text" data-f="text" rows="4" placeholder="粘贴一段该风格的正文样本">' + esc(s.text) + '</textarea>' +
      '</div>';
  }

  // 行内元素用**数组下标**认领归属，不用 id：
  // 新建的行 id 为 null，用 id 找会得到 NaN 而静默丢失输入（实测踩过：规则标题填了却报「标题必填」）。
  function sampleRow(s, idx) {
    return '<div class="rule-row" data-sample-idx="' + idx + '">' +
      '<div class="rule-row-head">' +
      '<input class="rule-title" data-f="title" value="' + esc(s.title) + '" placeholder="段名（可空）">' +
      '<span class="rule-src">' + (s.charCount || 0) + ' 字' + (s.indexed ? ' · 已索引' : '') + '</span>' +
      '<button class="btn btn-small btn-ghost" data-del-sample="1" type="button">删除</button>' +
      '</div>' +
      '<textarea class="rule-text" data-f="text" rows="4" placeholder="粘贴一段该风格的正文样本">' + esc(s.text) + '</textarea>' +
      '</div>';
  }

  function ruleRow(r, idx) {
    var opts = ['must', 'normal', 'hint'].map(function (s) {
      return '<option value="' + s + '"' + (r.severity === s ? ' selected' : '') + '>' + SEV_LABEL[s] + '</option>';
    }).join('');
    return '<div class="rule-row" data-rule-idx="' + idx + '">' +
      '<div class="rule-row-head">' +
      '<input class="rule-cat" data-f="category" value="' + esc(r.category) + '" placeholder="分类" size="6">' +
      '<input class="rule-title" data-f="title" value="' + esc(r.title) + '" placeholder="标题">' +
      '<select class="rule-sev" data-f="severity">' + opts + '</select>' +
      '<button class="btn btn-small btn-ghost" data-del-rule="1" type="button">删除</button>' +
      '</div>' +
      '<input class="rule-trigger" data-f="trigger" value="' + esc(r.trigger) + '" placeholder="触发词（用 | 分隔，如：悲伤|愤怒）">' +
      '<textarea class="rule-text" data-f="rule" rows="3" placeholder="规则正文">' + esc(r.rule) + '</textarea>' +
      '<div class="rule-examples">' +
      '<input data-f="bad" value="' + esc(r.bad) + '" placeholder="✗ 反面例（可选）">' +
      '<input data-f="good" value="' + esc(r.good) + '" placeholder="✓ 正面例（可选）">' +
      '</div>' +
      '<input class="rule-src-input" data-f="source" value="' + esc(r.source) + '" placeholder="出处（便于日后追溯）">' +
      '</div>';
  }

  // 把表单里的卡级字段收回 S.editing。
  // 必须在每次 renderEditor 之前调用：renderEditor 会按 S.editing 重写输入框，
  // 而「加一条规则」「加一段范文」都会触发它——不先回收，用户刚敲的卡名/人设就被自己点了加规则给抹了。
  function collectForm() {
    if (!S.editing) return;
    var c = S.editing;
    var name = $('card-name');
    if (name) c.pack.name = name.value;
    var persona = $('card-persona');
    if (persona) c.pack.persona = persona.value;
    var profile = $('card-profile');
    if (profile) c.pack.profile = textToProfile(profile.value);
    var enabled = $('card-enabled');
    if (enabled) c.pack.enabled = enabled.checked;
    var kind = $('card-kind');
    if (kind && !c.pack.builtin) c.pack.kind = kind.value;
  }

  function renderEditor() {
    var c = S.editing;
    if (!c) return;
    $('card-editor-title').textContent = c.pack.id ? ('编辑：' + c.pack.name) : '新建卡片';
    $('card-name').value = c.pack.name || '';
    $('card-kind').value = c.pack.kind || 'preset';
    $('card-persona').value = c.pack.persona || '';
    $('card-profile').value = profileToText(c.pack.profile);
    $('card-enabled').checked = c.pack.enabled !== false;
    $('card-kind').disabled = Boolean(c.pack.builtin);
    $('card-delete').style.display = c.pack.builtin ? 'none' : '';
    $('card-rules').innerHTML = (c.rules || []).map(function (r, i) { return ruleRow(r, i); }).join('') ||
      '<p class="empty-hint">还没有规则条目。</p>';
    $('card-samples').innerHTML = (c.samples || []).map(function (s, i) { return sampleRow(s, i); }).join('') ||
      '<p class="empty-hint">还没有范文段落。（范文可选：有语料才注入）</p>';
    bindEditorRows();
  }

  // 重画之前先回收表单（加规则/加范文/删行都会走到这里）
  function rerenderKeepingForm() {
    collectForm();
    renderEditor();
  }

  // 行内编辑直接落到 S.editing，保存时统一提交（避免每敲一个字打一次接口）。
  // input 与 change 都绑：change 只在失焦时触发，用户「敲完直接点保存」在某些情境下会丢字，
  // input 逐次同步才稳（只写内存，不打接口，无性能代价）。
  function bindFieldSync(root, listName, idxAttr) {
    root.querySelectorAll('[data-f]').forEach(function (el) {
      var sync = function () {
        var row = this.closest('.rule-row');
        var item = listName[Number(row.dataset[idxAttr])];
        if (item) item[this.dataset.f] = this.value;
      };
      el.oninput = sync;
      el.onchange = sync;
    });
  }

  function bindEditorRows() {
    var rulesBox = $('card-rules');
    if (rulesBox) {
      bindFieldSync(rulesBox, S.editing.rules, 'ruleIdx');
      rulesBox.querySelectorAll('[data-del-rule]').forEach(function (btn) {
        btn.onclick = async function () {
          var row = this.closest('.rule-row');
          var idx = Number(row.dataset.ruleIdx);
          var target = S.editing.rules[idx];
          if (!target) return;
          if (!confirm('删除这条规则？')) return;
          try {
            // 已入库的先删服务端；新建未保存的直接从数组剔除
            if (target.id) await App.api('DELETE', '/api/style-lab/rules/' + target.id);
            S.editing.rules.splice(idx, 1);
            rerenderKeepingForm();
          } catch (e) { App.toast(e.message); }
        };
      });
    }
    var sampBox = $('card-samples');
    if (sampBox) {
      bindFieldSync(sampBox, S.editing.samples, 'sampleIdx');
      sampBox.querySelectorAll('[data-del-sample]').forEach(function (btn) {
        btn.onclick = async function () {
          var row = this.closest('.rule-row');
          var idx = Number(row.dataset.sampleIdx);
          var target = S.editing.samples[idx];
          if (!target) return;
          if (!confirm('删除这段范文？')) return;
          try {
            // 必须走 pack 域路由：顶层 DELETE /samples/:id 被先注册的错题库「标本」路由遮蔽
            // （两张不同的表），走它会 404「标本不存在」甚至误删同 id 标本（2026-09-19 修复）
            if (target.id) await App.api('DELETE', '/api/style-lab/packs/' + S.editing.pack.id + '/samples/' + target.id);
            S.editing.samples.splice(idx, 1);
            rerenderKeepingForm();
          } catch (e) { App.toast(e.message); }
        };
      });
    }
  }

  async function openEditor(id) {
    try {
      var res = await App.api('GET', '/api/style-lab/packs/' + id);
      S.editing = { pack: res.pack, rules: res.rules || [], samples: res.samples || [] };
      $('card-editor').classList.remove('hidden');
      renderEditor();
    } catch (e) { App.toast(e.message); }
  }

  function openNew() {
    S.editing = {
      pack: { id: null, name: '', kind: 'preset', persona: '', profile: {}, enabled: true, builtin: false },
      rules: [], samples: [],
    };
    $('card-editor').classList.remove('hidden');
    renderEditor();
  }

  async function saveEditor() {
    var c = S.editing;
    if (!c) return;
    var msg = $('card-editor-msg');
    var payload = {
      name: $('card-name').value.trim(),
      persona: $('card-persona').value,
      profile: textToProfile($('card-profile').value),
      enabled: $('card-enabled').checked,
    };
    if (!c.pack.builtin) payload.kind = $('card-kind').value;
    if (!payload.name) { if (msg) msg.textContent = '卡名必填'; return; }
    try {
      var saved;
      if (c.pack.id) {
        saved = (await App.api('PUT', '/api/style-lab/packs/' + c.pack.id, payload)).pack;
      } else {
        saved = (await App.api('POST', '/api/style-lab/packs', payload)).pack;
      }
      c.pack = saved;
      // 规则与范文：新建的行走 POST，已有的走 PUT（改动只提交一次）
      for (var i = 0; i < c.rules.length; i++) {
        var r = c.rules[i];
        var body = {
          category: r.category, title: r.title, trigger: r.trigger, rule: r.rule,
          good: r.good, bad: r.bad, severity: r.severity, source: r.source,
        };
        if (r.id) await App.api('PUT', '/api/style-lab/rules/' + r.id, body);
        else await App.api('POST', '/api/style-lab/packs/' + saved.id + '/rules', body);
      }
      for (var j = 0; j < c.samples.length; j++) {
        var s = c.samples[j];
        var sbody = { title: s.title, text: s.text, source: s.source };
        if (s.id) await App.api('PUT', '/api/style-lab/samples/' + s.id, sbody);
        else await App.api('POST', '/api/style-lab/packs/' + saved.id + '/samples', sbody);
      }
      App.toast('卡片已保存，下一轮对话生效');
      await load();
      openEditor(saved.id); // 重新拉一次，新建的规则/范文拿到 id
    } catch (e) {
      if (msg) msg.textContent = e.message;
      else App.toast(e.message);
    }
  }

  async function deleteEditor() {
    var c = S.editing;
    if (!c || !c.pack.id) return;
    if (!confirm('删除卡片「' + c.pack.name + '」？\n\n卡片内的规则与范文一并删除，无法找回。已绑定这张卡的书会自动解绑。')) return;
    try {
      await App.api('DELETE', '/api/style-lab/packs/' + c.pack.id);
      $('card-editor').classList.add('hidden');
      S.editing = null;
      App.toast('卡片已删除');
      await load();
    } catch (e) { App.toast(e.message); }
  }

  function bindOnce() {
    var n = $('cards-new');
    if (n && !n.dataset.bound) { n.dataset.bound = '1'; n.onclick = openNew; }
    var cl = $('card-editor-close');
    if (cl && !cl.dataset.bound) {
      cl.dataset.bound = '1';
      cl.onclick = function () { $('card-editor').classList.add('hidden'); };
    }
    var sv = $('card-save');
    if (sv && !sv.dataset.bound) { sv.dataset.bound = '1'; sv.onclick = saveEditor; }
    var del = $('card-delete');
    if (del && !del.dataset.bound) { del.dataset.bound = '1'; del.onclick = deleteEditor; }
    var ar = $('card-add-rule');
    if (ar && !ar.dataset.bound) {
      ar.dataset.bound = '1';
      ar.onclick = function () {
        S.editing.rules.push({
          id: null, category: '通用', title: '', trigger: '', rule: '',
          good: '', bad: '', severity: 'normal', source: '手写',
        });
        rerenderKeepingForm();
      };
    }
    var as = $('card-add-sample');
    if (as && !as.dataset.bound) {
      as.dataset.bound = '1';
      as.onclick = function () {
        S.editing.samples.push({ id: null, title: '', text: '', source: '手写' });
        rerenderKeepingForm();
      };
    }
  }

  Cards.show = async function (bookId) {
    S.bookId = bookId;
    var back = $('cards-return');
    // 返回枢纽是个人中心（#/profile）：作家卡页的唯一入口已迁到那里
    if (back) back.href = '#/profile';
    bindOnce();
    await load();
  };
})();
