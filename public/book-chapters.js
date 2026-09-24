(function () {
    'use strict';

    var App = window.App;
    var BookPage = window.BookPage = window.BookPage || {};

    function $(id) { return document.getElementById(id); }
    function basePath() { return '/api/books/' + App.state.currentBook.id + '/chapters'; }
    function volPath() { return '/api/books/' + App.state.currentBook.id + '/volumes'; }
    // 回收站挂在书下、不在 /chapters 之下：多拼一段会被「GET /chapters/:id」路由当成
    // 章节名吃掉返回 404「章节不存在」（S1-06 冒烟实测踩过）。
    function recyclePath() { return '/api/books/' + App.state.currentBook.id + '/chapter-recycle'; }
    function updateWordCount() {
        var content = $('chapter-content').value;
        var len = content.replace(/\s/g, '').length;
        $('word-count').textContent = '共 ' + len + ' 字';
    }

    // ---------- 手工编辑保护（方向报告 1.9）：脏跟踪 + 防抖自动保存 + 离开提醒 ----------
    // AI 追加/替换前服务端都会拍版本快照，作者手写反而无保护：误关页面即丢整段手稿。
    // 服务端已在 PUT 时对正文变化拍 before-manual-edit 快照（版本链已覆盖），
    // 此处补齐前端：脏状态可见、停笔 3 秒自动落库、切章先保存、关页/刷新弹离开确认。
    var editBaseline = null;
    var editDirty = false;
    // C02/S1-04：编辑代数——每次输入递增。保存提交时快照当时的代数；成功返回时
    // 只有「代数未变（保存期间没有新输入）」才允许标干净，否则新输入保持脏状态。
    var editGeneration = 0;
    var autoSaveTimer = null;
    var autoSaving = false;
    var AUTO_SAVE_DELAY_MS = 3000;

    // S1-03/C04-B：服务端章节版本快照（chapters.revision，单调递增）。selectChapter/
    // 保存成功/重命名成功时刷新；PUT 必须携带 expected_revision，版本不符=别处已改，
    // 走 ChapterConflict 显式二选一，不静默覆盖也不自动以新版本重发旧全文。
    var chapterRevision = null;

    function currentEdit() {
        return { title: $('chapter-title-input').value, content: $('chapter-content').value, beat: $('chapter-beat').value };
    }
    function setEditDirty(v) {
        editDirty = v;
        var btn = $('btn-save-chapter');
        if (btn) {
            btn.classList.toggle('mode-on', v);
            btn.title = v ? '有未保存修改，停笔 3 秒后自动保存' : '';
        }
    }
    function markEditClean() {
        editBaseline = currentEdit();
        setEditDirty(false);
    }
    function checkEditDirty() {
        if (!editBaseline) return;
        var c = currentEdit();
        setEditDirty(c.title !== editBaseline.title || c.content !== editBaseline.content || c.beat !== editBaseline.beat);
    }
    function onManualInput() {
        editGeneration += 1; // C02：输入即推进编辑代数，保存标干净要以此比对
        checkEditDirty();
        if (editDirty) scheduleAutoSave();
    }
    function scheduleAutoSave() {
        if (autoSaveTimer) clearTimeout(autoSaveTimer);
        autoSaveTimer = setTimeout(function () {
            autoSaveTimer = null;
            autoSaveNow();
        }, AUTO_SAVE_DELAY_MS);
    }
    async function autoSaveNow() {
        if (!editDirty || autoSaving || !App.state.currentChapterId) return;
        autoSaving = true;
        try {
            var ok = await BookPage.saveChapter(true);
            if (ok) App.toast('已自动保存');
        } finally { autoSaving = false; }
    }
    function clearEditState() {
        editBaseline = null;
        chapterRevision = null;
        setEditDirty(false);
    }

    window.addEventListener('beforeunload', function (e) {
        if (!editDirty || !App.state.currentChapterId) return;
        e.preventDefault();
        e.returnValue = '';
    });

    // 分卷管理：编辑卷信息（含卷大纲）
    function volumeModal(vol) {
        App.openModal({
            title: vol ? '编辑分卷' : '新建分卷',
            bodyHTML:
                '<label class="field"><span>卷名</span><input id="vol-title" value="' + App.escapeHtml(vol ? vol.title : '') + '"></label>' +
                '<label class="field"><span>卷简介</span><textarea id="vol-intro" rows="2">' + App.escapeHtml(vol ? vol.intro : '') + '</textarea></label>' +
                '<label class="field"><span>卷大纲（AI 写作时会严格参考）</span><textarea id="vol-outline" rows="8" placeholder="本卷的阶段目标、关键事件、必须回收的伏笔…">' + App.escapeHtml(vol ? vol.outline : '') + '</textarea></label>',
            onOk: async function (body) {
                var title = body.querySelector('#vol-title').value.trim();
                if (!title) { App.toast('请填写卷名'); return false; }
                var payload = {
                    title: title,
                    intro: body.querySelector('#vol-intro').value.trim(),
                    outline: body.querySelector('#vol-outline').value.trim()
                };
                try {
                    if (vol) {
                        await App.api('PUT', volPath() + '/' + vol.id, payload);
                    } else {
                        await App.api('POST', volPath(), payload);
                    }
                    await BookPage.loadChapters();
                } catch (e) {
                    App.toast(e.message);
                    return false;
                }
            }
        });
    }

    // 分卷折叠状态（2026-09-11 实测缺陷）：此前折叠只存在于 DOM——卷行 class + 章节行内联
    // display:none。但 loadChapters 每次都整表重建 innerHTML，而它有 15 个调用点
    // （新建/删除/重命名章节、切章、保存与 3 秒自动保存、AI 写完刷新、大纲页刷新……），
    // 于是「折叠好的卷，一新建章节就自动展开」。
    // 修复：状态提到 window.ChapterCollapse（按书存放），渲染时回放。
    var collapseStore = window.ChapterCollapse.createStore();

    function currentBookId() {
        return App.state.currentBook && App.state.currentBook.id;
    }

    function isVolumeCollapsed(volId) {
        return collapseStore.isCollapsed(currentBookId(), volId);
    }

    // S1-06/C05：章节回收站。删章不再不可逆——正文与历史版本随回收快照保全，
    // 此处列出并恢复。恢复不重排全书（追加到卷末），原卷已删时按 409 清单让作者选卷。
    function openChapterRecycleModal() {
        App.openModal({
            title: '章节回收站',
            bodyHTML: '<div id="chapter-recycle-list" class="recycle-list"><p class="empty-hint">加载中…</p></div>',
            onOk: function () { /* 仅关闭 */ }
        });
        App.api('GET', recyclePath()).then(function (res) {
            renderChapterRecycleList((res && res.items) || []);
        }).catch(function (e) {
            var box = document.getElementById('chapter-recycle-list');
            if (box) box.innerHTML = '<p class="empty-hint">加载失败：' + App.escapeHtml(e.message) + '</p>';
        });
    }

    function renderChapterRecycleList(items) {
        var box = document.getElementById('chapter-recycle-list');
        if (!box) return;
        if (!items.length) {
            box.innerHTML = '<p class="empty-hint">回收站是空的。删除章节时会自动保留正文与历史版本。</p>';
            return;
        }
        var html = '';
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var volText = it.volume_title ? '原属《' + App.escapeHtml(it.volume_title) + '》· '
                : (it.volume_id ? '原卷已删 · ' : '');
            html += '<div class="recycle-item" data-rec="' + it.id + '">' +
                '<div><strong>' + App.escapeHtml(it.title) + '</strong>' +
                '<small>' + volText + it.chars + ' 字 · ' + it.versions + ' 个历史版本 · 删于 ' + App.escapeHtml(String(it.deleted_at)) + '</small></div>' +
                '<button class="btn btn-primary btn-small" type="button" data-restore="' + it.id + '">恢复</button>' +
                '</div>';
        }
        box.innerHTML = html;
        box.onclick = function (ev) {
            var btn = ev.target.closest('[data-restore]');
            if (btn) restoreRecycledChapter(Number(btn.dataset.restore));
        };
    }

    async function restoreRecycledChapter(recycleId, volumeId) {
        try {
            var payload = {};
            if (volumeId === null) payload.volume_id = null;
            else if (volumeId !== undefined) payload.volume_id = volumeId;
            var res = await App.api('POST', recyclePath() + '/' + recycleId + '/restore', payload);
            App.toast('已恢复《' + ((res.chapter && res.chapter.title) || '') + '》，' + res.reviewItems.length + ' 项待核对');
            App.closeModal();
            await BookPage.loadChapters();
            if (res.chapter && res.chapter.id && window.BookPage.selectChapter) BookPage.selectChapter(res.chapter.id);
        } catch (e) {
            if (e && e.code === 'VOLUME_REQUIRED') {
                promptRestoreVolume(recycleId, e.details && e.details.volumes);
            } else if (e && e.code === 'RECYCLE_RECORD_NOT_FOUND') {
                App.toast(e.message);
                openChapterRecycleModal();
            } else {
                App.toast(e.message);
            }
        }
    }

    function promptRestoreVolume(recycleId, volumes) {
        var opts = '';
        for (var i = 0; i < (volumes || []).length; i++) {
            opts += '<option value="' + volumes[i].id + '">' + App.escapeHtml(volumes[i].title) + '</option>';
        }
        App.openModal({
            title: '选择恢复到哪一卷',
            bodyHTML:
                '<p class="field-hint">该章原属的分卷已删除。选择目标卷，或恢复为未归卷稍后手动归卷。</p>' +
                '<label class="field"><span>目标卷</span><select id="recycle-target-volume"><option value="">未归卷（稍后手动归卷）</option>' + opts + '</select></label>',
            okText: '恢复',
            onOk: function (body) {
                var sel = body.querySelector('#recycle-target-volume');
                var v = sel && sel.value ? Number(sel.value) : null;
                restoreRecycledChapter(recycleId, v);
                return false; // 成功路径里统一关闭弹窗
            },
        });
    }

    // 章节重命名（可发现性缺口，2026-09-11）：章节行此前只有「读」「×」两个按钮，
    // 改名唯一入口是编辑器顶部的标题框——作者在目录里看不出章节名可改（分卷行有 ✎，章节行没有）。
    // 交互对齐分卷：点 ✎ 弹窗改标题。只提交 title，不动正文（服务端改标题不解除定稿）。
    function chapterRenameModal(ch) {
        if (!ch) return;
        App.openModal({
            title: '重命名章节',
            bodyHTML:
                '<label class="field"><span>章节标题</span><input id="chapter-rename-title" maxlength="120" autocomplete="off" value="' + App.escapeHtml(ch.title || '') + '"></label>' +
                '<p class="field-hint">只改标题，不含正文；已定稿的章节改名不会解除定稿。</p>',
            okText: '保存',
            onOk: async function (body) {
                var title = body.querySelector('#chapter-rename-title').value.trim();
                if (!title) { App.toast('请填写章节标题'); return false; }
                try {
                    // 改的是当前打开章节且编辑器有未保存改动：先落库，否则随后的自动保存
                    // 会拿标题框里的旧标题把这次改名覆盖回去（标题也在脏检查基线里）
                    if (ch.id === App.state.currentChapterId && editDirty) {
                        await BookPage.saveChapter(true);
                    }
                    // expected_revision：列表行可能是几秒前的快照，别拿旧版本盖掉别处刚改的；
                    // 若改的是当前打开章，上面的「先落库」已刷新 chapterRevision，以它为准
                    var renameRev = (ch.id === App.state.currentChapterId && chapterRevision != null)
                        ? chapterRevision
                        : Number(ch.revision);
                    var putRes = await App.api('PUT', basePath() + '/' + ch.id, {
                        title: title,
                        expected_revision: renameRev
                    });
                    if (ch.id === App.state.currentChapterId) {
                        $('chapter-title-input').value = title;
                        if (putRes && putRes.chapter && putRes.chapter.revision != null) {
                            chapterRevision = Number(putRes.chapter.revision);
                        }
                        markEditClean();
                    }
                    await BookPage.loadChapters();
                    App.toast('已重命名');
                } catch (e) {
                    if (e && e.code === 'CHAPTER_CONFLICT') {
                        App.toast('该章已在别处被修改，列表已刷新，请确认标题后重试');
                        await BookPage.loadChapters();
                    } else {
                        App.toast(e.message);
                    }
                    return false;
                }
            }
        });
    }

    BookPage.loadChapters = async function () {
        try {
            var volRes = await App.api('GET', volPath());
            var volumes = volRes.volumes || [];
            var res = await App.api('GET', basePath());
            var chapters = res.chapters || [];
            var list = $('chapter-list');

            // 记录最新卷，供新建章节归属
            if (volumes.length && !App.state.currentVolumeId) {
                App.state.currentVolumeId = volumes[volumes.length - 1].id;
            }

            var html = '';
            for (var v = 0; v < volumes.length; v++) {
                var vol = volumes[v];
                var volChapters = [];
                for (var i = 0; i < chapters.length; i++) {
                    if (chapters[i].volume_id === vol.id) volChapters.push(chapters[i]);
                }
                // 卷总结过期标记（方向报告 4.1）：章总结已变，卷总结讲的还是旧故事
                var staleMark = vol.summary_stale
                    ? '<span class="vol-stale" title="卷内章节总结已变化，本卷总结基于旧内容生成，建议重新生成">总结过期</span>'
                    : '';
                // 折叠态回放：本次渲染前该卷是否被折叠（见 collapseStore 注释）
                var isCollapsed = isVolumeCollapsed(vol.id);
                html += '<li class="volume-row' + (isCollapsed ? ' collapsed' : '') + '" data-vol="' + vol.id + '">' +
                    '<span class="vol-toggle">' + (isCollapsed ? '▸' : '▾') + '</span>' +
                    '<span class="vol-name">' + App.escapeHtml(vol.title) + '</span>' +
                    staleMark +
                    '<span class="vol-count">' + volChapters.length + ' 章</span>' +
                    '<span class="item-ops">' +
                    '<button class="icon-btn edit-vol" type="button" title="编辑卷信息/大纲">✎</button>' +
                    '<button class="icon-btn del-vol" type="button" title="删除分卷">×</button>' +
                    '</span></li>';
                for (var c = 0; c < volChapters.length; c++) {
                    var ch = volChapters[c];
                    var active = ch.id === App.state.currentChapterId ? ' active' : '';
                    var dotClass = ch.summary ? '' : ' none';
                    var driftBadge = '';
                    if (ch.drift_status === 'minor' || ch.drift_status === 'major') {
                        driftBadge = '<span class="drift-badge ' + ch.drift_status + '" title="' + App.escapeHtml(ch.drift_note || '') + '">' +
                            (ch.drift_status === 'major' ? '严重偏离' : '轻度偏离') + '</span>';
                    }
                    var lockBadge = ch.locked
                      ? '<span class="lock-badge" title="已定稿' + (ch.locked_at ? '（' + ch.locked_at + '）' : '') + '：内容已进入向量检索">定稿</span>'
                          + (ch.indexed ? '' : '<span class="lock-badge reindex-missing" title="已定稿但向量索引缺失：AI 语义检索找不到这章。点击重建" role="button">索引缺失·点此重建</span>')
                      : (!ch.relock_pending ? '' : '<span class="lock-badge relock" title="本章曾定稿，正文已修改：语义检索暂停覆盖，请核对后重新定稿">待重定稿</span>');
                    html += '<li class="item-row chapter-row' + active + '" data-id="' + ch.id + '" data-vol="' + vol.id + '"' + (isCollapsed ? ' style="display:none"' : '') + '>' +
                        '<span class="summary-dot' + dotClass + '"></span>' +
                        '<span class="item-name">' + App.escapeHtml(ch.title) + '</span>' + driftBadge + lockBadge +
                        '<span class="item-ops"><button class="icon-btn edit-chapter" title="重命名本章" type="button">✎</button><button class="icon-btn open-read" title="在阅读/精修页打开本章" type="button">读</button><button class="icon-btn del-chapter" type="button">×</button></span>' +
                        '</li>';
                }
            }
            // 未归卷/悬空卷章节兜底：volume_id 为空或指向已删卷时，这些章节此前在写作页
            // 完全不可见、无法编辑（但真实存在于章节序列）。单独成组展示，至少可打开编辑。
            var volumeIds = {};
            for (var vi = 0; vi < volumes.length; vi++) volumeIds[volumes[vi].id] = true;
            var orphanChapters = chapters.filter(function (c) { return !c.volume_id || !volumeIds[c.volume_id]; });
            if (orphanChapters.length) {
                html += '<li class="volume-row orphan-volume-row" title="这些章节未归属任何现有分卷（可能是跨书挂卷或卷删除残留），可在编辑器中打开，建议重新归卷">' +
                    '<span class="vol-name">未归卷</span>' +
                    '<span class="vol-count">' + orphanChapters.length + ' 章</span>' +
                    '<span class="item-ops"></span></li>';
                for (var oi = 0; oi < orphanChapters.length; oi++) {
                    var och = orphanChapters[oi];
                    var oActive = och.id === App.state.currentChapterId ? ' active' : '';
                    var oDot = och.summary ? '' : ' none';
                    html += '<li class="item-row chapter-row' + oActive + '" data-id="' + och.id + '" data-vol="">' +
                        '<span class="summary-dot' + oDot + '"></span>' +
                        '<span class="item-name">' + App.escapeHtml(och.title) + '</span>' +
                        (och.locked ? '<span class="lock-badge" title="已定稿">定稿</span>' : '') +
                        (och.locked && !och.indexed ? '<span class="lock-badge reindex-missing" title="已定稿但向量索引缺失，点击重建" role="button">索引缺失</span>' : '') +
                        '<span class="item-ops"><button class="icon-btn edit-chapter" title="重命名本章" type="button">✎</button><button class="icon-btn open-read" title="在阅读/精修页打开本章" type="button">读</button><button class="icon-btn del-chapter" title="删除章节" type="button">×</button></span>' +
                        '</li>';
                }
            }
            list.innerHTML = html;

            // 卷头交互：折叠/编辑/删除（孤儿组头部无卷操作，排除在配对外）
            var volRows = list.querySelectorAll('.volume-row:not(.orphan-volume-row)');
            for (var k = 0; k < volRows.length; k++) {
                (function (row, vol) {
                    row.onclick = async function (e) {
                        if (e.target.closest('.edit-vol')) {
                            volumeModal(vol);
                            return;
                        }
                        if (e.target.closest('.del-vol')) {
                            if (!confirm('删除《' + vol.title + '》？卷内章节会移到其他卷')) return;
                            try {
                                await App.api('DELETE', volPath() + '/' + vol.id);
                                if (App.state.currentVolumeId === vol.id) App.state.currentVolumeId = null;
                                // 清掉该卷的折叠记录：卷 id 会被 SQLite 复用，残留记录会让
                                // 新建的卷"凭空是折叠的"（持久化后尤其明显）
                                collapseStore.expand(currentBookId(), vol.id);
                                await refreshChapterRevision(App.state.currentChapterId); // 挪章归属会递增 revision
                                await BookPage.loadChapters();
                            } catch (err) { App.toast(err.message); }
                            return;
                        }
                        // 折叠/展开本卷章节（状态写入 collapseStore，供后续重渲染回放）
                        row.classList.toggle('collapsed');
                        var rows = list.querySelectorAll('.chapter-row[data-vol="' + vol.id + '"]');
                        var hide = row.classList.contains('collapsed');
                        for (var m = 0; m < rows.length; m++) {
                            rows[m].style.display = hide ? 'none' : '';
                        }
                        row.querySelector('.vol-toggle').textContent = hide ? '▸' : '▾';
                        collapseStore.setCollapsed(currentBookId(), vol.id, hide);
                    };
                })(volRows[k], volumes[k]);
            }

            // 章节交互
            var chapterById = {};
            for (var ci = 0; ci < chapters.length; ci++) chapterById[chapters[ci].id] = chapters[ci];
            var items = list.querySelectorAll('.chapter-row');
            for (var j = 0; j < items.length; j++) {
                (function (li, id) {
                    li.onclick = async function (e) {
                        if (e.target.closest('.edit-chapter')) {
                            chapterRenameModal(chapterById[id]);
                            return;
                        }
                        if (e.target.closest('.reindex-missing')) {
                            // 一键补建缺失向量索引（方向报告 3.2）：服务端异步执行，首章可能冷加载模型
                            try {
                                var r = await App.api('POST', basePath() + '/reindex', {});
                                App.toast(r.missing > 0
                                    ? '后台重建 ' + r.missing + ' 章索引中…（模型冷加载可能需 10~30 秒，稍后列表自动刷新）'
                                    : '没有缺失的索引');
                                if (r.missing > 0) setTimeout(function () { BookPage.loadChapters(); }, 12000);
                            } catch (err) { App.toast(err.message); }
                            return;
                        }
                        if (e.target.closest('.open-read')) {
                            location.hash = '#/book/' + App.state.currentBook.id + '/read/' + id;
                            return;
                        }
                        if (e.target.closest('.del-chapter')) {
                            if (!confirm('删除该章节？正文与历史版本会进入回收站，可随时恢复。')) return;
                            try {
                                await App.api('DELETE', basePath() + '/' + id);
                                if (id === App.state.currentChapterId) {
                                    App.state.currentChapterId = null;
                                    $('editor-body').classList.add('hidden');
                                    $('editor-empty').classList.remove('hidden');
                                    clearEditState();
                                }
                                await BookPage.loadChapters();
                            } catch (err) {
                                App.toast(err.message);
                            }
                        } else {
                            BookPage.selectChapter(id);
                        }
                    };
                })(items[j], parseInt(items[j].dataset.id, 10));
            }
        } catch (e) {
            App.toast(e.message);
        }
    };

    // ---------- C03/S1-05：离开闸门（切章/切书共用） ----------
    // 保存成功（含期间无新输入，S1-04 代数规则）放行；否则弹「重试保存/留在当前/明确放弃」
    // 三选一并拦下。放弃必须作者点击，任何错误不得隐式当作放弃。
    function saveBeforeLeave() {
        if (!editDirty || !App.state.currentChapterId) return Promise.resolve(true);
        return BookPage.saveChapter(true).then(function (ok) {
            return ok === true && !editDirty; // 保存期间又有新输入＝未保存完，继续拦
        });
    }

    function unsavedChangesModal(actions) {
        App.openModal({
            title: '有未保存的修改',
            bodyHTML:
                '<p class="field-hint">本章还有未落库的修改（保存失败，或保存期间又有新输入），已留在本章，编辑器内容原样保留。离开前请先落库，或明确选择放弃。</p>' +
                '<div class="conflict-actions">' +
                '<button class="btn btn-primary btn-small" type="button" data-act="retry">重试保存并继续</button> ' +
                '<button class="btn btn-outline btn-small" type="button" data-act="stay">留在本章</button> ' +
                '<button class="btn btn-outline btn-small" type="button" data-act="discard">放弃修改并继续</button>' +
                '</div>',
            okText: '留在本章',
            onOk: function () { /* 关闭即留下 */ }
        });
        var box = document.querySelector('#modal-body .conflict-actions');
        if (!box) return;
        box.onclick = function (ev) {
            var btn = ev.target.closest('[data-act]');
            if (!btn) return;
            var act = btn.dataset.act;
            App.closeModal();
            if (act === 'retry' && typeof actions.onRetry === 'function') actions.onRetry();
            else if (act === 'discard' && typeof actions.onDiscard === 'function') actions.onDiscard();
            // stay：仅关闭弹窗
        };
    }

    BookPage.hasUnsavedChanges = function () {
        return !!(editDirty && App.state.currentChapterId);
    };

    // 作者明确放弃后由调用方调用：清脏放行，不再尝试保存
    BookPage.clearUnsaved = function () {
        clearEditState();
    };

    BookPage.leaveGuard = async function (actions) {
        if (await saveBeforeLeave()) return true;
        unsavedChangesModal(actions || {});
        return false;
    };

    // S4-03：正文编辑器的离开闸门注册进统一导航守卫——写作页与四个工作台共用
    // WorkspaceState.beforeNavigate 这一条路径（app.js 的 hashchange 只调它），
    // 于是「浏览器后退」与「切章/切书」不再各写一套 dirty 判断。此处不复制守卫逻辑：
    // leave 仍然走上面既有的三选一弹窗（S1-05 语义不变），只是把回调交给统一守卫的调用方。
    if (window.WorkspaceState && window.WorkspaceState.registerGuard) {
        window.WorkspaceState.registerGuard({
            key: 'writing-editor',
            label: '正文编辑器',
            isDirty: function () { return BookPage.hasUnsavedChanges(); },
            discard: function () { BookPage.clearUnsaved(); },
            leave: function (ctx) {
                var actions = ctx || {};
                return BookPage.leaveGuard({
                    onRetry: actions.retry,
                    onDiscard: function () {
                        BookPage.clearUnsaved(); // 放弃必须作者点击：清脏由 clearUnsaved 显式完成
                        if (typeof actions.discard === 'function') actions.discard();
                    },
                });
            },
        });
    }

    BookPage.selectChapter = async function (cid) {
        if (cid !== App.state.currentChapterId) {
            var canLeave = await BookPage.leaveGuard({
                onRetry: function () { BookPage.selectChapter(cid); },
                onDiscard: function () { BookPage.clearUnsaved(); BookPage.selectChapter(cid); },
            });
            if (!canLeave) return;
        }
        try {
            var res = await App.api('GET', basePath() + '/' + cid);
            var chapter = res.chapter;
            chapterRevision = Number.isFinite(Number(chapter.revision)) ? Number(chapter.revision) : null;
            App.state.currentChapterId = cid;
            App.state.currentVolumeId = chapter.volume_id || App.state.currentVolumeId;
            $('editor-empty').classList.add('hidden');
            $('editor-body').classList.remove('hidden');
            $('chapter-title-input').value = chapter.title || '';
            $('chapter-content').value = chapter.content || '';
            $('chapter-beat').value = chapter.beat || '';
            markEditClean();
            updateLockBtn(!!chapter.locked);
            updateRelockBanner(!!chapter.relock_pending);
            updateWordCount();
            if (chapter.summary) {
                $('summary-box').classList.remove('hidden');
                $('summary-text').textContent = chapter.summary;
            } else {
                $('summary-box').classList.add('hidden');
            }
            await BookPage.loadChapters();
            // 专注模式面包屑同步钩子（模块未加载时为空操作）
            if (window.FocusMode) window.FocusMode.sync();
        } catch (e) {
            App.toast(e.message);
        }
    };

    // PUT 带 expected_revision：快照缺版本（428）时按服务端契约先重读一次当前 revision
    // 再提交（「先读后写」协议），仅此一个防御性重试；版本不符（409）原样抛给调用方
    // 走冲突对话，绝不静默换新版本重发。
    async function putChapterWithRevision(cid, body) {
        var payload = Object.assign({}, body);
        if (chapterRevision != null) payload.expected_revision = chapterRevision;
        try {
            return await finishSave(await App.api('PUT', basePath() + '/' + cid, payload), cid);
        } catch (e) {
            if (e && e.code === 'CHAPTER_REVISION_REQUIRED' && chapterRevision == null) {
                var fresh = await App.api('GET', basePath() + '/' + cid);
                chapterRevision = Number.isFinite(Number(fresh.chapter.revision)) ? Number(fresh.chapter.revision) : null;
                if (chapterRevision == null) throw e;
                payload.expected_revision = chapterRevision;
                return await finishSave(await App.api('PUT', basePath() + '/' + cid, payload), cid);
            }
            throw e;
        }
    }

    // 保存成功后刷新版本快照（服务端返回的 chapter.revision 即新基准）
    async function finishSave(res, cid) {
        if (res && res.chapter && res.chapter.revision != null && cid === App.state.currentChapterId) {
            chapterRevision = Number(res.chapter.revision);
        }
        return res;
    }

    // 409/428 冲突：拉服务端最新版弹显式二选一。本地稿留在编辑器（不清脏基线），
    // 重载由作者点击确认。
    async function showChapterConflict(cid, local) {
        var fresh;
        try {
            fresh = await App.api('GET', basePath() + '/' + cid);
        } catch (e2) {
            App.toast('获取服务端最新版本失败：' + e2.message + '（本地稿已保留，可先手动复制）');
            return;
        }
        if (window.ChapterConflict) {
            window.ChapterConflict.show({
                server: fresh.chapter,
                local: local,
                onReload: function (srv) {
                    if (cid !== App.state.currentChapterId) return; // 弹窗期间已切章：不动编辑器
                    $('chapter-title-input').value = srv.title || '';
                    $('chapter-content').value = srv.content || '';
                    $('chapter-beat').value = srv.beat || '';
                    chapterRevision = Number.isFinite(Number(srv.revision)) ? Number(srv.revision) : null;
                    markEditClean();
                    updateWordCount();
                    updateLockBtn(!!srv.locked);
                    updateRelockBanner(!!srv.relock_pending);
                    if (window.BookPage.loadChapters) BookPage.loadChapters();
                }
            });
        } else {
            App.toast('章节已在别处被修改，本地稿已保留在编辑器中，请核对后重试');
        }
    }

    // lock/unlock/生成总结/删卷挪章等服务端会递增 revision 但响应不回传新值的操作：
    // 轻量重读刷新快照，否则下一次保存会拿旧版本 409。只更新版本与定稿态，不动编辑器。
    async function refreshChapterRevision(cid) {
        if (cid == null || cid !== App.state.currentChapterId) return;
        try {
            var res = await App.api('GET', basePath() + '/' + cid);
            if (res && res.chapter) {
                chapterRevision = Number.isFinite(Number(res.chapter.revision)) ? Number(res.chapter.revision) : null;
                updateLockBtn(!!res.chapter.locked);
                updateRelockBanner(!!res.chapter.relock_pending);
            }
        } catch (e) { /* 静默：快照刷新失败不阻断主流程，版本不符仍有 409 冲突兜底 */ }
    }

    // 保存单飞：手动「保存」按钮与 3 秒防抖自动保存可能并发（冒烟实测 run1：两次 PUT 携带
    // 同一旧 revision，后到者 409 弹出假冲突）。并发调用共享同一次飞行，返回同一结果；
    // 飞行期间的新输入仍为脏，下一个防抖窗口会再保存，不丢内容。
    var saveInFlight = null;

    BookPage.saveChapter = async function (quiet) {
        if (!App.state.currentChapterId) return false;
        if (saveInFlight) return saveInFlight;
        saveInFlight = BookPage._doSaveChapter(quiet);
        var ok;
        try { ok = await saveInFlight; }
        finally { saveInFlight = null; }
        return ok;
    };

    BookPage._doSaveChapter = async function (quiet) {
        if (!App.state.currentChapterId) return false;
        try {
            var cid = App.state.currentChapterId;
            var bookIdAtSubmit = App.state.currentBook.id;
            var submittedGeneration = editGeneration;
            var title = $('chapter-title-input').value.trim() || '未命名';
            var content = $('chapter-content').value;
            var beat = $('chapter-beat').value.trim();
            var res = await putChapterWithRevision(cid, { title: title, content: content, beat: beat });
            if (res && res.autoUnlocked) {
                updateLockBtn(false);
                updateRelockBanner(true);
                App.toast('该章原定稿，修改后已自动解除定稿');
            } else if (!quiet) {
                App.toast('已保存');
            }
            // C02/S1-04 标干净三条件：同一书章 + 持久化成功（200 即 durable，再读
            // persistence 字段做契约校验）+ 保存期间无新输入（编辑代数与提交快照一致）。
            // 期间的新输入保持脏，交给下一个防抖窗口以服务端新 revision 保存。
            var durable = !(res && res.persistence) || res.persistence.durable !== false;
            if (durable
                && cid === App.state.currentChapterId
                && bookIdAtSubmit === App.state.currentBook.id
                && submittedGeneration === editGeneration) {
                markEditClean();
            }
            await BookPage.loadChapters();
            return true;
        } catch (e) {
            if (e && e.code === 'PERSISTENCE_PENDING') {
                // S1-01 契约：业务已应用但未落盘。不当失败重放（内存里已写入），
                // 不标干净（未持久化）；静默重读刷新版本快照——服务器已推进 revision，
                // 磁盘自愈后的下一笔保存不应拿旧版本制造假冲突。
                App.toast('内容已保存到内存，磁盘暂不可用，系统正在自动重试落盘；请勿关闭页面');
                await refreshChapterRevision(cid);
                return false;
            }
            if (e && (e.code === 'CHAPTER_CONFLICT' || e.code === 'CHAPTER_REVISION_REQUIRED')) {
                await showChapterConflict(cid, {
                    title: $('chapter-title-input').value,
                    content: $('chapter-content').value,
                    beat: $('chapter-beat').value
                });
                return false;
            }
            App.toast(e.message);
            return false;
        }
    };

    // 定稿按钮状态：已定稿 → 高亮+文案「解除定稿」
    function updateLockBtn(locked) {
        var btn = $('btn-lock-chapter');
        if (!btn) return;
        btn.textContent = locked ? '解除定稿' : '定稿';
        btn.classList.toggle('mode-on', locked);
    }

    // 「定稿后被修改」警示条：显示时提供一键重新定稿
    function updateRelockBanner(show) {
        var banner = $('relock-banner');
        if (!banner) return;
        banner.classList.toggle('hidden', !show);
    }

    async function toggleLock() {
        if (!App.state.currentChapterId) return;
        var cid = App.state.currentChapterId;
        var locked = $('btn-lock-chapter').classList.contains('mode-on');
        if (locked) {
            try {
                await App.api('POST', basePath() + '/' + cid + '/unlock');
                updateLockBtn(false);
                App.toast('已解除定稿，向量索引已移除');
                await refreshChapterRevision(cid); // 解锁会递增 revision，刷新快照
                await BookPage.loadChapters();
            } catch (e) { App.toast(e.message); }
            return;
        }
        await doRelock('已定稿，后台建立向量索引中');
    }

    // 保存最新内容后定稿并重建语义索引（「定稿」按钮与警示条「重新定稿」共用）
    async function doRelock(toastText) {
        var cid = App.state.currentChapterId;
        if (!cid) return;
        await BookPage.saveChapter(true);
        try {
            await App.api('POST', basePath() + '/' + cid + '/lock');
            updateLockBtn(true);
            updateRelockBanner(false);
            App.toast(toastText);
            await refreshChapterRevision(cid); // 重新定稿会递增 revision，刷新快照
            await BookPage.loadChapters();
        } catch (e) { App.toast(e.message); }
    }

    BookPage.bindChapterEvents = function () {
        var tabs = document.querySelectorAll('.tab[data-tab]');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].onclick = function () {
                var tab = this.getAttribute('data-tab');
                var allTabs = document.querySelectorAll('.tab[data-tab]');
                for (var k = 0; k < allTabs.length; k++) {
                    allTabs[k].classList.remove('active');
                }
                this.classList.add('active');
                var panels = ['tab-chapters', 'tab-outline', 'tab-state', 'tab-world', 'tab-characters'];
                for (var m = 0; m < panels.length; m++) {
                    var panel = $(panels[m]);
                    if (panel) {
                        if (panels[m] === 'tab-' + tab) {
                            panel.classList.remove('hidden');
                        } else {
                            panel.classList.add('hidden');
                        }
                    }
                }
            };
        }

        $('btn-add-chapter').onclick = async function () {
            try {
                var payload = {};
                if (App.state.currentVolumeId) payload.volume_id = App.state.currentVolumeId;
                var res = await App.api('POST', basePath(), payload);
                var chapter = res.chapter;
                // 新章节若落在被折叠的卷里：只展开这一卷，让新行可见（其他卷的折叠状态不动）
                if (chapter.volume_id) collapseStore.expand(currentBookId(), chapter.volume_id);
                await BookPage.loadChapters();
                await BookPage.selectChapter(chapter.id);
            } catch (e) {
                App.toast(e.message);
            }
        };

        $('btn-add-volume').onclick = function () {
            volumeModal(null);
        };

        $('btn-chapter-recycle').onclick = openChapterRecycleModal;

        $('btn-open-read').onclick = function () {
            var cid = App.state.currentChapterId;
            location.hash = '#/book/' + App.state.currentBook.id + '/read' + (cid ? '/' + cid : '');
        };

        // 编辑器底部「进入精修」大按钮：流程引导，必带当前章节直达精修页
        $('btn-enter-refine').onclick = function () {
            var cid = App.state.currentChapterId;
            if (!cid) { App.toast('先在左侧选择或新建一个章节'); return; }
            location.hash = '#/book/' + App.state.currentBook.id + '/read/' + cid;
        };

        $('btn-save-chapter').onclick = function () {
            BookPage.saveChapter();
        };

        $('btn-relock').onclick = function () {
            doRelock('已重新定稿，后台重建语义索引中');
        };
        $('btn-lock-chapter').onclick = toggleLock;

        var contentEl = $('chapter-content');
        if (!contentEl.dataset.bound) {
            contentEl.addEventListener('input', function () {
                updateWordCount();
                onManualInput();
            });
            contentEl.dataset.bound = '1';
        }
        var titleEl = $('chapter-title-input');
        if (!titleEl.dataset.bound) {
            titleEl.addEventListener('input', onManualInput);
            titleEl.dataset.bound = '1';
        }
        var beatEl = $('chapter-beat');
        if (!beatEl.dataset.bound) {
            beatEl.addEventListener('input', onManualInput);
            beatEl.dataset.bound = '1';
        }

        $('btn-gen-summary').onclick = async function () {
            if (!App.state.currentChapterId) return;
            var btn = this;
            try {
                await BookPage.saveChapter(true);
                btn.disabled = true;
                btn.textContent = '生成中…';
                var cid = App.state.currentChapterId;
                var res = await App.api('POST', basePath() + '/' + cid + '/summary');
                var summary = res.summary;
                $('summary-box').classList.remove('hidden');
                $('summary-text').textContent = summary;
                await refreshChapterRevision(cid); // 写入总结会递增 revision，刷新快照
                await BookPage.loadChapters();
            } catch (e) {
                App.toast(e.message);
            } finally {
                btn.disabled = false;
                btn.textContent = '生成总结';
            }
        };

        // ---------- 润色 ----------
        function polishModal(scope, selectedText, selStart, selEnd) {
            App.openModal({
                title: scope === 'selection' ? '润色选中段落' : '润色本章',
                bodyHTML:
                    '<label class="field"><span>润色要求（可选）</span>' +
                    '<input id="polish-req" placeholder="如：加强画面感 / 删减冗余 / 对话更自然"></label>',
                okText: '开始润色',
                onOk: async function (body) {
                    var requirement = body.querySelector('#polish-req').value.trim();
                    var cid = App.state.currentChapterId;
                    if (!cid) { App.toast('请先选择章节'); return false; }
                    await BookPage.saveChapter(true); // 先保存，保证润色基于最新内容
                    App.toast('润色中…');
                    try {
                        var payload = { scope: scope, requirement: requirement };
                        if (scope === 'selection') payload.selected_text = selectedText;
                        var res = await App.api('POST', basePath() + '/' + cid + '/polish', payload);
                        var original = scope === 'selection' ? selectedText : $('chapter-content').value;
                        window.DiffView.show({
                            scope: scope,
                            original: original,
                            polished: res.polished,
                            onAccept: async function (polished) {
                                var c = $('chapter-content');
                                if (scope === 'selection') {
                                    // 润色是网络往返，期间正文可能被再次编辑：快照偏移与原文不符时回退重定位，
                                    // 避免 splice 错位把改动落在错误位置（与阅读台 applyReplyToSelection 同防御）
                                    var sStart = selStart, sEnd = selEnd;
                                    if (c.value.slice(sStart, sEnd) !== selectedText) {
                                        var idx = c.value.indexOf(selectedText);
                                        if (idx < 0) { App.toast('正文中已找不到选中段落，润色结果未应用（正文已被改动）'); return; }
                                        sStart = idx; sEnd = idx + selectedText.length;
                                    }
                                    c.value = c.value.slice(0, sStart) + polished + c.value.slice(sEnd);
                                } else {
                                    c.value = polished;
                                }
                                updateWordCount();
                                await BookPage.saveChapter(true);
                                App.toast('已采纳润色并保存');
                            }
                        });
                    } catch (e) {
                        App.toast(e.message);
                        return false;
                    }
                }
            });
        }

        // 整章润色
        $('btn-polish-chapter').onclick = function () {
            if (!App.state.currentChapterId) return;
            if (!$('chapter-content').value.trim()) { App.toast('章节内容为空'); return; }
            polishModal('chapter');
        };

        // 选中段落润色：监听选区
        if (!contentEl.dataset.selBound) {
            var checkSel = function () {
                var btn = $('btn-polish-selection');
                var has = contentEl.selectionStart < contentEl.selectionEnd;
                btn.classList.toggle('hidden', !has);
            };
            contentEl.addEventListener('mouseup', checkSel);
            contentEl.addEventListener('keyup', checkSel);
            contentEl.dataset.selBound = '1';
        }
        $('btn-polish-selection').onclick = function () {
            var s = contentEl.selectionStart, e = contentEl.selectionEnd;
            if (s >= e) return;
            polishModal('selection', contentEl.value.slice(s, e), s, e);
        };

        // diff 视图按钮（幂等绑定）
        if (window.DiffView && !window.DiffView._bound) {
            window.DiffView.bind();
            window.DiffView._bound = true;
        }
    };
})();
