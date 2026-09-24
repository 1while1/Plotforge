(function () {
  var CharacterAdvisor = window.CharacterAdvisor = {};
  var state = { route: null, character: null, sessions: [] };
  function esc(value) { return window.App.escapeHtml(value == null ? '' : String(value)); }
  function api(method, path, body) { return window.App.api(method, '/api/books/' + encodeURIComponent(state.route.bookId) + path, body); }
  function base() { return '/characters/' + state.character.id + '/advisor'; }

  function citationHTML(citation) {
    if (!citation) return ''; // 防御：脏数据里混入 null 引用时不中断整次渲染
    return '<li><button class="advisor-anchor" data-anchor="' + esc(citation.anchor) + '" title="在当前正文中核对这条证据">' + esc(citation.anchor) + '</button><blockquote>' + esc(citation.quote_snapshot || citation.quote || '') + '</blockquote><span>' + esc(citation.trust_class || citation.trustClass || '') + ' · ' + esc(citation.canonical_status || citation.canonicalStatus || '') + '</span></li>';
  }

  function suggestionHTML(item) {
    var assumptions = (item.assumptions || []).map(function (value) { return '<li>' + esc(value) + '</li>'; }).join('');
    var impacts = (item.impacts || []).map(function (value) { return '<li>' + esc(typeof value === 'string' ? value : JSON.stringify(value)) + '</li>'; }).join('');
    var citations = (item.citations || []).map(citationHTML).join('');
    return '<article class="advisor-suggestion" data-suggestion-id="' + item.id + '">' +
      '<header><span class="advisor-type type-' + esc(item.type || item.suggestion_type) + '">' + esc(item.type || item.suggestion_type) + '</span><div><h3>' + esc(item.title) + '</h3><small>' + esc(item.status || 'active') + '</small></div></header>' +
      '<section><h4>结论</h4><p>' + esc(item.conclusion) + '</p></section>' +
      (item.inference ? '<section><h4>推断</h4><p>' + esc(item.inference) + '</p></section>' : '') +
      (assumptions ? '<details><summary>假设边界</summary><ul>' + assumptions + '</ul></details>' : '') +
      (impacts ? '<details><summary>潜在影响</summary><ul>' + impacts + '</ul></details>' : '') +
      '<details class="advisor-evidence" open><summary>证据 ' + (item.citations || []).length + ' 条</summary><ul>' + citations + '</ul></details>' +
      (item.status === 'active' || !item.status ? '<footer><button class="btn btn-primary btn-small advisor-adopt">采纳到…</button><button class="btn btn-ghost btn-small advisor-ignore">忽略</button></footer>' : '') + '</article>';
  }

  function sessionHTML(session) {
    return '<section class="advisor-session"><div class="advisor-session-head"><div><span class="workbench-kicker">' + esc(session.trigger_kind || 'manual') + '</span><h2>' + esc(session.focus || '人物分析') + '</h2></div><time>' + esc((session.created_at || '').replace('T', ' ').slice(0, 16)) + '</time></div><div class="advisor-suggestions">' + (session.suggestions || []).map(suggestionHTML).join('') + '</div><button class="btn btn-ghost advisor-follow-up" data-session-id="' + session.id + '">继续追问</button></section>';
  }

  function shellHTML() {
    return '<div class="advisor-workspace"><header class="advisor-hero"><div><span class="workbench-kicker">EVIDENCE-GROUNDED ADVISOR</span><h2>' + esc(state.character.name) + ' · 人物顾问</h2><p>基于人物档案、关系、台账、故事线与正文证据给出建议。推断不会冒充事实。</p></div><button id="advisor-sandbox" class="btn btn-ghost">沙盘推演</button></header>' +
      '<form id="advisor-form" class="advisor-compose"><div class="form-grid"><label>分析焦点<select id="advisor-focus"><option>人物弧光</option><option>动机一致性</option><option>关系张力</option><option>行为选择</option></select></label><label>建议类型<select id="advisor-types" multiple><option value="A" selected>A · 人设一致性</option><option value="B" selected>B · 剧情机会</option><option value="C" selected>C · 风险冲突</option><option value="D" selected>D · 弧光推进</option></select></label></div><label>你想解决什么问题？<textarea id="advisor-question" rows="3" placeholder="例如：下一次出场怎样既推进主线，又不破坏他对权威的戒备？"></textarea></label><div class="advisor-compose-actions"><span>每条结论都可展开查看证据</span><button class="btn btn-primary" type="submit">生成顾问建议</button></div></form>' +
      '<div id="advisor-results">' + (state.sessions.length ? state.sessions.map(sessionHTML).join('') : '<section class="workbench-empty-card"><h3>还没有顾问记录</h3><p>选择一个分析焦点，顾问会在固定证据包内给出可追溯建议。</p></section>') + '</div></div>';
  }

  function bind() {
    document.getElementById('advisor-form').onsubmit = function (event) { event.preventDefault(); run(false); };
    document.getElementById('advisor-sandbox').onclick = function () { run(true); };
    document.querySelectorAll('.advisor-ignore').forEach(function (button) { button.onclick = function () { ignore(button.closest('[data-suggestion-id]').dataset.suggestionId); }; });
    document.querySelectorAll('.advisor-adopt').forEach(function (button) { button.onclick = function () { adopt(button.closest('[data-suggestion-id]').dataset.suggestionId); }; });
    document.querySelectorAll('.advisor-follow-up').forEach(function (button) { button.onclick = function () { followUp(button.dataset.sessionId); }; });
    bindAnchorLookup();
  }

  // 证据锚点核对：点击引用里的锚点按钮 → 拉当前正文对应段落，展示引用是否仍然有效。
  // 事件委托一次绑定，沙盘弹窗里渲染的锚点同样生效（后端 GET /evidence/anchors/:anchor）。
  function bindAnchorLookup() {
    if (bindAnchorLookup._bound) return;
    bindAnchorLookup._bound = true;
    document.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('.advisor-anchor') : null;
      if (!button) return;
      var anchor = button.dataset.anchor;
      if (!anchor) return;
      window.App.api('GET', '/api/books/' + encodeURIComponent(state.route.bookId) + '/evidence/anchors/' + encodeURIComponent(anchor))
        .then(function (result) {
          var loc = result.location || {};
          window.App.openModal({
            title: '证据核对', okText: '关闭',
            bodyHTML: '<p class="field-hint">锚点 ' + esc(anchor) + ' · 第 ' + esc(loc.chapterId != null ? loc.chapterId : '?') + ' 章第 ' + esc((loc.paragraphIndex != null ? loc.paragraphIndex : '?')) + ' 段</p>' +
              '<blockquote>' + esc(result.quote || '（当前正文中没有这一段）') + '</blockquote>' +
              (result.stale ? '<p class="test-result fail">已失效：正文在建议生成后被修改过，此引用不再对应当前内容。</p>' : '<p class="test-result ok">有效：与当前定稿正文一致。</p>')
          });
        })
        .catch(function (error) { window.App.toast('证据核对失败：' + error.message); });
    });
  }

  async function refresh() {
    var response = await api('GET', base() + '/sessions?limit=20');
    state.sessions = response.items || [];
    document.getElementById('character-tab-content').innerHTML = shellHTML();
    bind();
  }

  async function run(isSandbox) {
    var question = document.getElementById('advisor-question').value.trim();
    var types = Array.from(document.getElementById('advisor-types').selectedOptions).map(function (option) { return option.value; });
    var button = isSandbox ? document.getElementById('advisor-sandbox') : document.querySelector('#advisor-form button[type="submit"]');
    button.disabled = true; button.textContent = '正在核对证据…';
    try {
      var result = await api('POST', base() + (isSandbox ? '/sandbox' : '/sessions'), { focus: document.getElementById('advisor-focus').value, question: question, types: types });
      if (isSandbox) {
        window.App.openModal({ title: '非正典沙盘结果', okText: '关闭', bodyHTML: '<div class="advisor-suggestions sandbox">' + result.suggestions.map(suggestionHTML).join('') + '</div>' });
      } else await refresh();
    } catch (error) { window.App.toast(error.message); }
    finally { button.disabled = false; button.textContent = isSandbox ? '沙盘推演' : '生成顾问建议'; }
  }

  async function ignore(id) { await api('POST', base() + '/suggestions/' + id + '/ignore', {}); await refresh(); window.App.toast('已忽略；证据未变化前不会重复出现'); }

  function adopt(id) {
    window.App.openModal({
      title: '选择采纳目标', okText: '确认采纳',
      bodyHTML: '<label>写入位置<select id="advisor-target"><option value="story_thread">新建故事线</option><option value="character_profile">人物档案备注</option><option value="advisor_note">仅标记采纳（不落地实体）</option></select></label><label>标题或补充说明<textarea id="advisor-adopt-note" rows="4" placeholder="留空则使用建议的标题与结论"></textarea></label>',
      onOk: async function (body) {
        var target = body.querySelector('#advisor-target').value;
        var note = body.querySelector('#advisor-adopt-note').value.trim();
        var payload = target === 'character_profile' ? { patch: { note: note } } : { title: note, summary: note };
        await api('POST', base() + '/suggestions/' + id + '/adopt', { target: target, payload: payload });
        await refresh(); window.App.toast('建议已采纳到指定位置');
      }
    });
  }

  function followUp(sessionId) {
    window.App.openModal({ title: '继续追问', okText: '提交追问', bodyHTML: '<label>新问题<textarea id="advisor-follow-question" rows="5" placeholder="新的问题会连同上一轮结论和最新证据一起分析"></textarea></label>', onOk: async function (body) { var question = body.querySelector('#advisor-follow-question').value.trim(); if (!question) return false; await api('POST', base() + '/sessions/' + sessionId + '/follow-up', { question: question }); await refresh(); } });
  }

  CharacterAdvisor.show = async function (route, character) {
    state.route = route; state.character = character; state.sessions = [];
    document.getElementById('character-tab-content').innerHTML = '<div class="workbench-loading">正在读取人物顾问记录…</div>';
    try { await refresh(); } catch (error) { document.getElementById('character-tab-content').innerHTML = '<div class="workbench-error">' + esc(error.message) + '</div>'; }
  };
})();
