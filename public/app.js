
    (function () {
      'use strict';

      var App = window.App = {};
      var state = { currentBook: null, currentChapterId: null, currentVolumeId: null };
      App.state = state;

      var toastTimer = null;
      var defaultSystemPrompt = '';

      // ---------- 工具函数 ----------
      async function api(method, url, body) {
        var opts = {
          method: method,
          headers: { 'Content-Type': 'application/json' }
        };
        if (body !== undefined) opts.body = JSON.stringify(body);
        var res = await fetch(url, opts);
        if (!res.ok) {
          var msg = '请求失败';
          var errCode, errDetails;
          try {
            var data = await res.json();
            if (data && data.error !== undefined) {
              // error 可能是字符串，也可能是结构化对象 {code, message, details}——
              // 直接塞进 Error 会变成 "[object Object]"，界面上没法读。
              // 结构化解析交给 chat-event-hub：message 保持字符串兼容旧调用方（toast(e.message)），
              // 同时把 code/details 附到 Error 上，下游按封闭枚举分支，不再正则猜文案。
              var parsed = window.ChatEventHub ? ChatEventHub.parseErrorBody(data) : null;
              if (parsed) {
                msg = parsed.message;
                errCode = parsed.code;
                errDetails = parsed.details;
              } else {
                msg = typeof data.error === 'string'
                  ? data.error
                  : (data.error && data.error.message) || JSON.stringify(data.error);
              }
            }
          } catch (e) { /* ignore */ }
          var err = new Error(msg);
          if (errCode !== undefined && errCode !== null) err.code = errCode;
          if (errDetails !== undefined) err.details = errDetails;
          err.status = res.status;
          throw err;
        }
        return res.json();
      }
      App.api = api;

      function toast(msg) {
        var el = document.getElementById('toast');
        el.textContent = msg;
        el.classList.remove('hidden');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
          el.classList.add('hidden');
        }, 2500);
      }
      App.toast = toast;

      function escapeHtml(s) {
        if (s == null) return '';
        return String(s).replace(/[&<>"']/g, function (c) {
          return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
          }[c];
        });
      }
      App.escapeHtml = escapeHtml;

      function openModal(opts) {
        var mask = document.getElementById('modal-mask');
        document.getElementById('modal-title').textContent = opts.title;
        document.getElementById('modal-body').innerHTML = opts.bodyHTML;
        document.getElementById('modal-ok').textContent = opts.okText || '确定';
        mask.classList.remove('hidden');

        var okBtn = document.getElementById('modal-ok');
        var cancelBtn = document.getElementById('modal-cancel');

        // 危险操作确认：红色按钮；每次打开都重置，避免状态残留
        if (opts.danger) {
          okBtn.classList.add('btn-danger');
        } else {
          okBtn.classList.remove('btn-danger');
        }

        okBtn.onclick = function () {
          var ret = opts.onOk(document.getElementById('modal-body'));
          if (ret && typeof ret.then === 'function') {
            ret.then(function (r) {
              if (r !== false) closeModal();
            }).catch(function () { /* ignore */ });
          } else if (ret !== false) {
            closeModal();
          }
        };
        cancelBtn.onclick = closeModal;
        mask.onclick = function (e) {
          if (e.target === mask) closeModal();
        };
      }
      App.openModal = openModal;

      function closeModal() {
        document.getElementById('modal-mask').classList.add('hidden');
      }
      App.closeModal = closeModal;

      // ---------- 路由 ----------
      function route() {
        var hash = location.hash || '#/';
        ['shelf', 'book', 'workbench', 'settings', 'agent', 'timeline', 'read', 'stylelab', 'cards', 'profile'].forEach(function (p) {
          document.getElementById('page-' + p).classList.add('hidden');
        });

        if (/^#\/book\/[^/]+\/workbench\//.test(hash)) {
          document.getElementById('page-workbench').classList.remove('hidden');
          if (window.WorkbenchShell) window.WorkbenchShell.show(hash);
          return;
        }

        var timelineMatch = hash.match(/^#\/book\/([^/?]+)\/characters\/([^/?]+)\/timeline/);
        if (timelineMatch) {
          var tlBookId = '', tlCid = '';
          try { tlBookId = decodeURIComponent(timelineMatch[1]); tlCid = decodeURIComponent(timelineMatch[2]); } catch (e) { tlBookId = ''; tlCid = ''; }
          if (!tlBookId || !tlCid) { location.hash = '#/'; return; }
          document.getElementById('page-timeline').classList.remove('hidden');
          if (window.CharacterTimeline) window.CharacterTimeline.showFullPage(tlBookId, tlCid);
          return;
        }

        // 作家卡（作家仓库）：#/book/:id/cards —— 独立整页，只读写自己的卡片表
        var cardsMatch = hash.match(/^#\/book\/([^/?]+)\/cards/);
        if (cardsMatch) {
          var cdBookId = '';
          try { cdBookId = decodeURIComponent(cardsMatch[1]); } catch (e) { cdBookId = ''; }
          if (!cdBookId) { location.hash = '#/'; return; }
          document.getElementById('page-cards').classList.remove('hidden');
          if (window.Cards) window.Cards.show(cdBookId);
          return;
        }

        // 错题库（作家仓库）：#/book/:id/stylelab —— 独立整页，只读写自己的标本表
        var labMatch = hash.match(/^#\/book\/([^/?]+)\/stylelab/);
        if (labMatch) {
          var labBookId = '';
          try { labBookId = decodeURIComponent(labMatch[1]); } catch (e) { labBookId = ''; }
          if (!labBookId) { location.hash = '#/'; return; }
          document.getElementById('page-stylelab').classList.remove('hidden');
          if (window.StyleLab) window.StyleLab.show(labBookId);
          return;
        }

        // 阅读 / 精修工作台：#/book/:id/read 或 #/book/:id/read/:chapterId
        var readMatch = hash.match(/^#\/book\/([^/?]+)\/read(?:\/([^/?]+))?/);
        if (readMatch) {
          var rdBookId = '';
          var rdCid = null;
          try {
            rdBookId = decodeURIComponent(readMatch[1]);
            if (readMatch[2]) rdCid = parseInt(decodeURIComponent(readMatch[2]), 10) || null;
          } catch (e) {
            rdBookId = '';
          }
          if (!rdBookId) {
            location.hash = '#/';
            return;
          }
          document.getElementById('page-read').classList.remove('hidden');
          if (window.ReadPage) window.ReadPage.show(rdBookId, rdCid);
          return;
        }

        if (hash.indexOf('#/book/') === 0) {
          var id = '';
          try {
            id = decodeURIComponent(hash.split('/')[2] || '');
          } catch (e) {
            id = '';
          }
          if (!id) {
            location.hash = '#/';
            return;
          }
          document.getElementById('page-book').classList.remove('hidden');
          if (window.BookPage) window.BookPage.show(id);
          return;
        }

        if (hash === '#/profile') {
          document.getElementById('page-profile').classList.remove('hidden');
          if (window.ProfilePage) window.ProfilePage.show();
          return;
        }

        if (hash === '#/settings') {
          document.getElementById('page-settings').classList.remove('hidden');
          renderSettings();
          return;
        }

        if (hash === '#/agent') {
          document.getElementById('page-agent').classList.remove('hidden');
          if (window.AgentPage) window.AgentPage.show();
          return;
        }

        if (hash !== '#/') {
          location.hash = '#/';
          return;
        }
        document.getElementById('page-shelf').classList.remove('hidden');
        renderShelf();
      }

      // ---------- 书架页 ----------
      async function renderShelf() {
        try {
          var data = await api('GET', '/api/books');
          var books = data.books || [];
          var grid = document.getElementById('book-grid');
          var empty = document.getElementById('shelf-empty');

          if (!books.length) {
            grid.innerHTML = '';
            empty.classList.remove('hidden');
          } else {
            empty.classList.add('hidden');
            grid.innerHTML = books.map(function (book) {
              var updated = (book.updated_at || '').slice(5, 10);
              return '' +
                '<div class="book-card" data-id="' + book.id + '">' +
                  '<h3>' + escapeHtml(book.title) + '</h3>' +
                  '<p class="book-intro">' + escapeHtml(book.intro || '暂无简介') + '</p>' +
                  '<div class="book-meta">' +
                    '<span>' + (book.chapter_count || 0) + ' 章 · ' + escapeHtml(updated) + '</span>' +
                    '<button class="icon-btn book-del" title="删除">×</button>' +
                  '</div>' +
                '</div>';
            }).join('');
          }

          grid.onclick = async function (e) {
            var del = e.target.closest('.book-del');
            var card = e.target.closest('.book-card');
            if (!card) return;
            var id = card.dataset.id;

            if (del) {
              var title = card.querySelector('h3').textContent;
              // 删除保护（方向报告 3.4）：先取将失去的内容统计，确认框强制展示
              try {
                var preview = await api('GET', '/api/books/' + id + '/delete-preview');
                var stats = preview.chapters + ' 章 · 约 ' + preview.words + ' 字 · ' + preview.characters + ' 个人物 · '
                  + preview.events + ' 条事实事件 · ' + preview.versions + ' 份版本快照 · ' + preview.messages + ' 条对话';
                var ok = confirm('确定删除《' + title + '》？\n\n将失去：' + stats + '\n\n删除前会自动导出整册备份进回收站（保留 30 天，可在书架右上角「回收站」恢复）。');
                if (!ok) return;
                var result = await api('DELETE', '/api/books/' + id);
                toast('已删除，备份已入回收站');
                renderShelf();
              } catch (err) {
                toast(err.message);
              }
            } else {
              location.hash = '#/book/' + id;
            }
          };
        } catch (e) {
          toast(e.message);
        }
      }

      // ---------- 设置页 ----------
      // 渠道预设：免费渠道走 opencode.ai/zen（免 Key），付费走 zen/go，Agnes 走 apihub，
      // StepFun 走官方 step_plan（作家印记蒸馏用的就是这个渠道，见 tools/distill/llm.js）。
      // 渠道 ↔ 模型的对应只是「切换时预填」，改完仍可手填任意值。
      var CHANNELS = {
        paid: { base_url: 'https://opencode.ai/zen/go/v1', model: 'deepseek-v4-flash' },
        free: { base_url: 'https://opencode.ai/zen/v1', model: 'deepseek-v4-flash-free' },
        agnes: { base_url: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.5-flash' },
        stepfun: { base_url: 'https://api.stepfun.com/step_plan/v1', model: 'step-3.7-flash' }
      };

      function detectChannel(baseUrl) {
        for (var key in CHANNELS) {
          if (baseUrl === CHANNELS[key].base_url) return key;
        }
        return 'custom';
      }

      // 各渠道的 API Key 分开记忆（localStorage），切渠道不用反复粘贴
      function keyStash() {
        try { return JSON.parse(localStorage.getItem('channel_keys') || '{}'); }
        catch (e) { return {}; }
      }
      function stashKey(channel, apiKey) {
        var stash = keyStash();
        stash[channel] = apiKey;
        localStorage.setItem('channel_keys', JSON.stringify(stash));
      }

      // 上下文窗口提示：三级信息源透明化（渠道 /models 官方报告 → 用户设置 → 系统默认），
      // 官方缺失/未拉取时明示，绝不把猜测当官方
      function setCtxHint(s) {
        var hint = document.getElementById('ctx-window-hint');
        if (!hint) return;
        if (s.context_window_clamped) {
          hint.textContent = '被钳制：设 ' + s.context_window + ' 超渠道官方 ' + s.context_window_official + '，生效 ' + s.context_window_resolved;
          hint.title = s.context_window_note || '';
        } else if (s.context_window_official_source === 'channel_reported') {
          hint.textContent = (s.context_window_auto ? '自动' : '生效 ' + s.context_window_resolved) + ' · 官方 ' + s.context_window_official + '（渠道 /models 报告）';
          hint.title = '拉取于 ' + (s.context_window_official_fetched_at || '-');
        } else if (s.context_window_official_source === 'channel_not_reported') {
          hint.textContent = (s.context_window_auto ? '自动（系统默认 ' + s.context_window_resolved + '）' : '按你设置生效 ' + s.context_window_resolved) + ' · 渠道未报官方，不猜测';
          hint.title = s.context_window_note || '';
        } else {
          hint.textContent = (s.context_window_auto ? '自动（系统默认 ' + s.context_window_resolved + '）' : '已手动锁定 ' + s.context_window_resolved) + ' · 官方源尚未拉取';
          hint.title = '';
        }
      }

      async function renderSettings() {
        try {
          var data = await api('GET', '/api/settings');
          var s = data.settings || {};
          defaultSystemPrompt = s.default_system_prompt || '';
          document.getElementById('set-base-url').value = s.base_url || '';
          // 后端不再回传明文密钥：输入框保持空白，用 placeholder 告知掩码与「留空即不变更」的语义
          var keyEl = document.getElementById('set-api-key');
          keyEl.value = '';
          keyEl.placeholder = s.api_key_set
            ? '已配置 ' + (s.api_key_masked || '') + '，留空则保持不变'
            : '未配置，粘贴 API Key';
          document.getElementById('set-model').value = s.model || '';
          var asEl = document.getElementById('set-anysearch-key');
          asEl.value = '';
          asEl.placeholder = s.anysearch_api_key_set
            ? '已配置 ' + (s.anysearch_api_key_masked || '') + '，留空则保持不变'
            : '未配置（可选，联网搜索用）';
          document.getElementById('set-search-enabled').checked = s.search_enabled !== false;
          document.getElementById('set-search-endpoint').value = s.anysearch_endpoint_effective || '';
          document.getElementById('set-search-max-results').value = s.search_max_results || 5;
          document.getElementById('set-search-freshness').value = s.search_freshness || '';
          document.getElementById('set-search-zone').value = s.search_zone || '';
          document.getElementById('set-context-window').value = s.context_window || '';
          document.getElementById('set-context-window').placeholder = String(s.context_window_resolved || 128000);
          setCtxHint(s);
          document.getElementById('set-compress-ratio').value = s.compression_ratio || '0.8';
          document.getElementById('set-disable-thinking').value = s.disable_thinking_models || '';
          document.getElementById('set-channel').value = detectChannel(s.base_url || '');
          var ta = document.getElementById('set-system-prompt');
          if (s.system_prompt) {
            ta.value = s.system_prompt;
            delete ta.dataset.isDefault;
          } else {
            ta.value = defaultSystemPrompt;
            ta.dataset.isDefault = '1';
          }
          renderStyleLab();
        } catch (e) {
          toast(e.message);
        }
      }

      // 作家仓库卡片（走 /api/style-lab/config，独立于 /api/settings）：
      // 拆成独立请求是有意的——风格层与体检是旁路能力，配置读不到也不该连累模型设置页
      async function renderStyleLab() {
        try {
          var data = await api('GET', '/api/style-lab/config');
          var c = data.config || {};
          var keyEl = document.getElementById('set-zhuque-key');
          if (keyEl) {
            keyEl.value = '';
            keyEl.placeholder = c.api_key_set
              ? '已配置 ' + (c.api_key_masked || '') + '，留空则保持不变'
              : '未配置（可选，体检用）';
          }
          var epEl = document.getElementById('set-zhuque-endpoint');
          if (epEl) epEl.value = c.detector_endpoint || '';
          var modeEl = document.getElementById('set-healthcheck-mode');
          if (modeEl) modeEl.value = c.healthcheck_mode || 'manual';
          var layerEl = document.getElementById('set-style-layer-enabled');
          if (layerEl) layerEl.checked = c.style_layer_enabled !== false;
        } catch (e) { /* 旁路能力：读不到就不显示，不打断设置页 */ }
      }

      // ---------- 初始化 ----------
      function init() {
        // 新建作品
        document.getElementById('btn-new-book').onclick = function () {
          openModal({
            title: '新建作品',
            bodyHTML:
              '<label class="field"><span>作品名称</span><input id="nb-title" placeholder="请输入作品名称"></label>' +
              '<label class="field"><span>作品简介</span><textarea id="nb-intro" rows="3" placeholder="可选"></textarea></label>',
            onOk: async function (body) {
              var title = body.querySelector('#nb-title').value.trim();
              if (!title) {
                toast('请填写作品名称');
                return false;
              }
              var intro = body.querySelector('#nb-intro').value.trim();
              try {
                var data = await api('POST', '/api/books', { title: title, intro: intro });
                location.hash = '#/book/' + data.book.id;
              } catch (e) {
                toast(e.message);
                return false;
              }
            }
          });
        };

        // 回收站（方向报告 3.4）：删书自动备份 30 天，可整册恢复或永久删除
        var binBtn = document.getElementById('btn-recycle-bin');
        // 恢复预览（S1-07/C12）：整册恢复前先看清单——将恢复什么、
        // 作家卡绑定是否依赖缺失；缺失时作者显式选择「仍要恢复（留空）」才继续，
        // 绝不静默半恢复。旧版备份明确列出不可恢复项。
        async function previewAndRestore(file) {
          var pv;
          try { pv = await api('POST', '/api/books/recycle-bin/preview', { file: file }); }
          catch (e) { toast(e.message); return; }
          var st = pv.style || {};
          var counts = pv.counts || {};
          var rows = [];
          rows.push('<p>《' + escapeHtml(pv.book.title) + '》· 备份于 ' + new Date(pv.exported_at).toLocaleString() + '</p>');
          rows.push('<p class="field-hint">将恢复：' + (counts.chapters || 0) + ' 章 · ' + (counts.chapter_versions || 0) + ' 个历史版本 · ' + (counts.messages || 0) + ' 条对话。向量索引在后台自动补建。</p>');
          if (st.legacy) {
            rows.push('<p class="field-hint" style="color:var(--danger)">这是旧版备份，不含作家卡绑定：</p>');
            (st.unavailable || []).forEach(function (s) { rows.push('<p class="field-hint">· 不可恢复：' + escapeHtml(s) + '</p>'); });
          } else {
            rows.push('<p class="field-hint">作家卡绑定：</p>');
            (st.bindings || []).forEach(function (b) {
              rows.push('<p class="field-hint">· ' + (b.role === 'main' ? '主卡' : '辅卡') + '《' + escapeHtml(b.pack_name) + '》'
                + (b.exists ? ' —— 已就绪' : ' —— <strong>卡已删除</strong>，恢复后该绑定留空，可新建卡后重绑') + '</p>');
            });
            if (!(st.bindings || []).length) rows.push('<p class="field-hint">（本书删除时未绑定作家卡）</p>');
          }
          var hasMissing = (st.missing || []).length > 0;
          openModal({
            title: '恢复预览',
            bodyHTML: rows.join(''),
            okText: hasMissing ? '仍要恢复（缺失绑定留空）' : '确认恢复',
            onOk: async function () {
              try {
                var res = await api('POST', '/api/books/recycle-bin/restore', { file: file, allow_partial_style: hasMissing });
                var msg = '已恢复《' + pv.book.title + '》到书架';
                var rs = res.style || {};
                if (rs.legacy) msg += '（旧版备份：作家卡绑定不可恢复）';
                else if ((rs.missing || []).length) msg += '（绑定缺 ' + rs.missing.length + ' 项，待新建卡重绑）';
                else msg += '（作家卡绑定 ' + (rs.restored_bindings || 0) + ' 项已恢复）';
                toast(msg);
                renderShelf();
                return true;
              } catch (e) { toast(e.message); return false; }
            },
          });
        }

        if (binBtn) binBtn.onclick = async function () {
          var data;
          try { data = await api('GET', '/api/books/recycle-bin'); }
          catch (e) { toast(e.message); return; }
          var list = data.backups || [];
          openModal({
            title: '回收站（保留 ' + (data.retention_days || 30) + ' 天）',
            bodyHTML: list.length
              ? '<div class="recycle-list">' + list.map(function (b) {
                  return '<div class="recycle-item" data-file="' + escapeHtml(b.file) + '">' +
                    '<div><strong>《' + escapeHtml(b.title) + '》</strong>' +
                    '<small>' + new Date(b.created_at).toLocaleString() + ' · ' + Math.max(1, Math.round(b.size / 1024)) + ' KB</small></div>' +
                    '<div><button class="btn btn-primary btn-small" data-restore="' + escapeHtml(b.file) + '">整册恢复</button> ' +
                    '<button class="btn btn-ghost btn-small" data-purge="' + escapeHtml(b.file) + '">永久删除</button></div>' +
                  '</div>';
                }).join('') + '</div>'
              : '<p class="empty-hint">回收站是空的。删除书籍时会自动在这里生成整册备份。</p>',
            onOk: function () {}
          });
          var box = document.querySelector('#modal-body .recycle-list'); // 应用模态是 #modal-body（无类），旧 .modal-body 选择器指向另一个模态导致按钮从未绑定
          if (!box) return;
          box.onclick = async function (ev) {
            var rBtn = ev.target.closest('[data-restore]');
            var pBtn = ev.target.closest('[data-purge]');
            try {
              if (rBtn) {
                await previewAndRestore(rBtn.dataset.restore);
              } else if (pBtn) {
                if (!confirm('永久删除这份备份？删除后无法找回。')) return;
                await api('DELETE', '/api/books/recycle-bin/' + encodeURIComponent(pBtn.dataset.purge));
                toast('备份已永久删除');
                closeModal();
                binBtn.click();
              }
            } catch (err) { toast(err.message); }
          };
        };

        // 按当前 UI 选中的模型刷新窗口解析值（?model 覆盖，不落库）
        function refreshCtxWindowField() {
          var curModel = document.getElementById('set-model').value.trim() || '';
          api('GET', '/api/settings' + (curModel ? '?model=' + encodeURIComponent(curModel) : ''))
            .then(function (data) {
              var s = data.settings || {};
              document.getElementById('set-context-window').value = s.context_window || '';
              document.getElementById('set-context-window').placeholder = String(s.context_window_resolved || 128000);
              setCtxHint(s);
            }).catch(function () {});
        }

        // 手动刷新渠道官方模型信息（/models 上下文上限，第一信息源）
        var rmBtn = document.getElementById('btn-refresh-models');
        if (rmBtn) rmBtn.onclick = function () {
          rmBtn.disabled = true;
          api('POST', '/api/settings/refresh-models', {})
            .then(function (d) { toast('已拉取渠道官方模型信息 ' + (d.count || 0) + ' 条'); renderSettings(); })
            .catch(function (e) { toast(e.message); })
            .finally(function () { rmBtn.disabled = false; });
        };

        // 渠道切换：自动填充对应 base_url、推荐模型和该渠道记住的 Key
        document.getElementById('set-channel').onchange = function () {
          var ch = this.value;
          if (ch === 'custom') return;
          document.getElementById('set-base-url').value = CHANNELS[ch].base_url;
          document.getElementById('set-model').value = CHANNELS[ch].model;
          var stash = keyStash()[ch] || '';
          var el = document.getElementById('set-api-key');
          el.value = ch === 'free' ? '' : stash;
          // 本地没记住该渠道的 Key 时明说，避免用户误以为「留空就会沿用服务端旧 Key」而发错渠道
          if (ch !== 'free' && !stash) el.placeholder = '该渠道本地未记住 Key，请粘贴';
          refreshCtxWindowField();
        };

        // 模型手改/手填后，窗口解析值跟随刷新
        var modelInput = document.getElementById('set-model');
        if (modelInput && !modelInput.dataset.ctxBound) {
          modelInput.dataset.ctxBound = '1';
          modelInput.addEventListener('change', refreshCtxWindowField);
        }

        // 保存设置
        document.getElementById('btn-save-settings').onclick = async function () {
          try {
            var settings = {
              base_url: document.getElementById('set-base-url').value.trim(),
              model: document.getElementById('set-model').value.trim(),
              context_window: document.getElementById('set-context-window').value.trim(),
              compression_ratio: document.getElementById('set-compress-ratio').value.trim(),
              // 深度思考开关：留空 = 不干预（与历史行为一致），故无条件发送空串是安全的
              disable_thinking_models: document.getElementById('set-disable-thinking').value.trim()
            };
            // 密钥字段：填了才发送；留空则不发该字段（后端视为不变更）。
            // 因为读不到明文，输入框默认就是空的，若照旧无条件发送会把已配置的密钥覆盖掉。
            // 免费渠道是例外：它本就无需 Key，留空即显式清空。
            var ch = document.getElementById('set-channel').value;
            var keyVal = document.getElementById('set-api-key').value.trim();
            if (keyVal) settings.api_key = keyVal;
            else if (ch === 'free') { settings.api_key = ''; settings.clear_api_key = true; } // 后端要求显式清除标志，否则空串会被当成「不变更」
            await api('PUT', '/api/settings', settings);
            if (ch !== 'custom' && ch !== 'free' && keyVal) stashKey(ch, keyVal);
            refreshCtxWindowField();
            toast('已保存');
            renderSettings(); // 重拉一次，让掩码与 placeholder 反映刚保存的结果
          } catch (e) {
            toast(e.message);
          }
        };

        // 保存提示词
        document.getElementById('btn-save-prompt').onclick = async function () {
          try {
            var ta = document.getElementById('set-system-prompt');
            var system_prompt = ta.dataset.isDefault === '1' ? '' : ta.value;
            await api('PUT', '/api/settings', { system_prompt: system_prompt });
            toast('已保存');
          } catch (e) {
            toast(e.message);
          }
        };

        // 重置提示词
        document.getElementById('btn-reset-prompt').onclick = function () {
          var ta = document.getElementById('set-system-prompt');
          ta.value = defaultSystemPrompt;
          ta.dataset.isDefault = '1';
        };

        // 保存搜索设置（AnySearch 卡片，独立于模型接口保存）
        document.getElementById('btn-save-search-settings').onclick = async function () {
          try {
            var settings = {
              search_enabled: document.getElementById('set-search-enabled').checked,
              search_max_results: document.getElementById('set-search-max-results').value.trim() || '5',
              search_freshness: document.getElementById('set-search-freshness').value,
              search_zone: document.getElementById('set-search-zone').value
            };
            // Key 同样「填了才发送」，避免空输入框洗掉已配置密钥
            var asVal = document.getElementById('set-anysearch-key').value.trim();
            if (asVal) settings.anysearch_api_key = asVal;
            await api('PUT', '/api/settings', settings);
            toast('搜索设置已保存');
            renderSettings(); // 重拉一次，让掩码与 placeholder 反映刚保存的结果
          } catch (e) {
            toast(e.message);
          }
        };

        // 测试搜索（真跑一次极小搜索，花付费额度时由用户主动触发）
        document.getElementById('btn-test-search').onclick = async function () {
          var btn = document.getElementById('btn-test-search');
          var result = document.getElementById('search-test-result');
          btn.disabled = true;
          btn.textContent = '测试中…';
          try {
            var data = await api('POST', '/api/settings/test-search');
            result.className = 'test-result ok';
            result.textContent = '搜索正常 · ' + String(data.snippet || '').slice(0, 80);
          } catch (e) {
            result.className = 'test-result fail';
            result.textContent = '搜索失败：' + e.message;
          } finally {
            btn.disabled = false;
            btn.textContent = '测试搜索';
          }
        };

        // 测试连接
        document.getElementById('btn-test-conn').onclick = async function () {
          var btn = document.getElementById('btn-test-conn');
          var result = document.getElementById('test-result');
          btn.disabled = true;
          btn.textContent = '测试中…';
          try {
            var data = await api('POST', '/api/settings/test');
            result.className = 'test-result ok';
            result.textContent = '连接正常 · ' + (data.model || '') + ' 回复：' + (data.reply || '');
          } catch (e) {
            result.className = 'test-result fail';
            result.textContent = '连接失败：' + e.message;
          } finally {
            btn.disabled = false;
            btn.textContent = '测试连接';
          }
        };

        // 保存作家仓库设置（朱雀 Key / 体检触发方式 / 文风注入开关）
        document.getElementById('btn-save-style-lab').onclick = async function () {
          try {
            var payload = {
              style_healthcheck_mode: document.getElementById('set-healthcheck-mode').value,
              style_layer_enabled: document.getElementById('set-style-layer-enabled').checked ? '1' : '0'
            };
            // Key「填了才发送」，避免空输入框洗掉已配置的密钥（与搜索 Key 同一约定）
            var zqVal = document.getElementById('set-zhuque-key').value.trim();
            if (zqVal) payload.zhuque_api_key = zqVal;
            await api('PUT', '/api/style-lab/config', payload);
            toast('作家仓库设置已保存');
            renderStyleLab();
          } catch (e) {
            toast(e.message);
          }
        };

        // 测试检测（花朱雀额度，由用户主动触发）
        document.getElementById('btn-test-zhuque').onclick = async function () {
          var btn = document.getElementById('btn-test-zhuque');
          var result = document.getElementById('zhuque-test-result');
          btn.disabled = true;
          btn.textContent = '检测中…';
          try {
            var data = await api('POST', '/api/style-lab/test');
            result.className = 'test-result ok';
            var conf = (typeof data.conf === 'number') ? data.conf : null;
            result.textContent = '检测正常 · 该样例 AI 置信度 ' + (conf === null ? '—' : conf.toFixed(4));
          } catch (e) {
            result.className = 'test-result fail';
            result.textContent = '检测失败：' + e.message;
          } finally {
            btn.disabled = false;
            btn.textContent = '测试检测';
          }
        };

        // 系统提示词输入监听
        document.getElementById('set-system-prompt').addEventListener('input', function () {
          delete this.dataset.isDefault;
        });

        // C03/S1-05 + S4-03：离开任何页面（写作台、四个工作台）前，若有未落库的编辑，先过统一守卫
        // （WorkspaceState.beforeNavigate：正文编辑器三选一、工作台表单保存→失败保留 dirty 并拦下）。
        // 保存失败则回退本次导航并留在原页（作者在弹窗/提示里「重试/放弃」后由回调重新导航）。
        // 浏览器前进/后退与站内跳转都汇聚到这一条 hashchange，hash 变了也要重新问一次守卫。
        // 浏览器关闭/刷新仍走 book-chapters.js 的 beforeunload 平台能力。
        var lastHash = location.hash || '#/';
        var revertingHash = false;
        function guardNavigation(to) {
          if (!window.WorkspaceState) return Promise.resolve(true);
          return WorkspaceState.beforeNavigate({
            from: lastHash,
            to: to,
            retry: function () { location.hash = to; },
            discard: function () { location.hash = to; },
          });
        }
        window.addEventListener('hashchange', function () {
          if (revertingHash) { revertingHash = false; return; }
          var to = location.hash || '#/';
          var from = lastHash;
          if (from === to) { route(); return; }
          guardNavigation(to).then(function (canLeave) {
            if (canLeave) {
              if (window.WorkspaceState) WorkspaceState.noteDeparture(from, to);
              lastHash = to;
              route();
              return;
            }
            revertingHash = true;
            location.hash = from; // 页面从未切换，编辑器与脏状态原样
          });
        });
        route();
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
      } else {
        init();
      }
    })();
