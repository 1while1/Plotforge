// S5-2（Plan §2.4/§2.5）：public/legacy/book-chapters.js（938 行）等值迁 React。
// 范式 A·判定 C：旧文件物理保留为死锚点（test/editor-vm.js:48、workspace-navigation.test.js:479、
// writing-workspace-state.test.js:433 等 vm 装载磁盘真源码，不可 git rm），真实浏览器由本组件
// 经旧名桥 window.MozhenChapterEditor（legacy-bridge.jsx 追加）＋ index.html:762 原位 inline
// classic bootstrap 的 8 个动态委托桩应答。
//
// 架构（§2.5 互操作契约）：
// - 单组件树：React root 挂 #editor-body（常驻壳节点，首挂后永不卸载）；createPortal 渲染
//   #chapter-list 目录行（两处状态同源：同一个 controller）。
// - 三输入非受控（defaultValue 常量 + 经 document.getElementById 直读写）：FocusModeOverlay
//   读 .value、book-chat.js 写 .value/#word-count 均不被 React 重渲染覆盖（React 对未变
//   props 不重写 DOM）。
// - #word-count / #btn-save-chapter / #btn-lock-chapter / #relock-banner / #summary-box /
//   #editor-body / #editor-empty 的显隐与文案一律命令式 classList/textContent 写（跨件共享契约）。
// - #diff-view 五件套常驻 React 树、同 id/tag/class；#diff-body 为不写 children 的叶容器
//   （MozhenDiffView.show 对它有命令式 root）。
// - 跨方法调用一律经 chapterEditorApi().<name> 名义入口（§2.5.8 补丁 B，V4 实证）：使刷新在内部
//   调用路径上与 legacy 逐次等价触发——P6-1 起刷新职责自持于 api 边界（下方返回对象的
//   api.saveChapter／api.selectChapter 经 withWritingStatusRefresh 包装，等价 book.js:154-163
//   的 wrapStatusRefresh 链，该链已随 P6-1 退役）。
// - 不写 window.BookPage（V3 反例：直接 Object.assign 会冲掉装载期包装链——链已退役，
//   但「桩/桥写点不得被组件覆盖」纪律不变：桩是名义入口的唯一落点，P6-2 拆桥面）。
import { useEffect, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { useWritingPrefs } from "../hooks/use-writing-prefs.js";
import { getApp } from "../lib/app-runtime.js";
import { createStore } from "../lib/chapter-collapse.js";
import { getWorkspaceState } from "../lib/workspace-state.js";
import { getChapterTarget } from "../lib/writing-prefs.js";
import { bindEditorDirtyProvider } from "../lib/writing-status.js";
import { withWritingStatusRefresh } from "../pages/BookShell.jsx";
import {
	ChapterFilterBar,
	ChapterFoot,
	ChapterRowMeta,
	chapterWords,
	formatWordCount,
	matchesChapterFilter,
} from "../shell/ChapterListChrome.jsx";
import {
	AppearanceMenu,
	ContinuePreview,
	EditorEyebrow,
	EditorMeta,
} from "../shell/EditorChrome.jsx";
import { showConflictDialog } from "./ChapterConflictDialog.jsx";
import {
	bind as bindDiff,
	isBound as diffIsBound,
	markBound as markDiffBound,
	show as showDiff,
} from "./DiffOverlay.jsx";
import { focusModeBridge } from "./FocusModeOverlay.jsx";

const AUTO_SAVE_DELAY_MS = 3000;

// ---------- 控制器：legacy 闭包态与全部方法逐字移植 ----------
// （React 只负责两处容器内容渲染；行为面与 legacy 同在 document 上按 id 直接读写。）
function createChapterEditorController({ listEl }) {
	const App = getApp();
	const collapseStore = createStore();

	// 手工编辑保护（:23-30）：脏跟踪 + 防抖自动保存 + 离开提醒
	let editBaseline = null;
	let editDirty = false;
	// C02/S1-04：编辑代数——每次输入递增；标干净要求代数未变（保存期间无新输入）
	let editGeneration = 0;
	let autoSaveTimer = null;
	let autoSaving = false;

	// S1-03/C04-B：服务端章节版本快照（chapters.revision）：PUT 必须携带 expected_revision
	let chapterRevision = null;

	// 保存单飞（:623）：并发调用共享同一次飞行；竞态修复（charter_amended #3）：飞行中的新保存
	// 调用记 pending，本笔成功后若编辑器仍脏补一次 quiet 保存；失败/409/ok=false 不补发。
	let saveInFlight = null;
	let savePendingRetry = false;

	// 目录渲染模型（React 订阅；loadChapters 整表更新 + 折叠切换时 emit）
	let listModel = { volumes: [], chapters: [], version: 0 };
	const listeners = new Set();

	const $ = (id) => document.getElementById(id);
	const basePath = () => `/api/books/${App.state.currentBook.id}/chapters`;
	const volPath = () => `/api/books/${App.state.currentBook.id}/volumes`;
	// 回收站挂在书下、不在 /chapters 之下（:10-12：多拼一段会被 GET /chapters/:id 吃掉返回 404）
	const recyclePath = () =>
		`/api/books/${App.state.currentBook.id}/chapter-recycle`;
	// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :127-129 守卫形态
	const currentBookId = () => App.state.currentBook && App.state.currentBook.id;

	function emit() {
		listModel = { ...listModel, version: listModel.version + 1 };
		for (const fn of Array.from(listeners)) fn(listModel);
	}

	// 编辑区工具条（状态徽章 / 字数进度）的数据源：只镜像命令式写点，不反向驱动 DOM
	let editorMeta = { locked: false, relock: false, words: 0, chapterId: null };
	const metaListeners = new Set();
	function setEditorMeta(patch) {
		const next = { ...editorMeta, ...patch };
		if (
			next.locked === editorMeta.locked &&
			next.relock === editorMeta.relock &&
			next.words === editorMeta.words &&
			next.chapterId === editorMeta.chapterId
		)
			return;
		editorMeta = next;
		for (const fn of Array.from(metaListeners)) fn(editorMeta);
	}

	function updateWordCount() {
		const content = $("chapter-content");
		if (!content) return;
		const len = content.value.replace(/\s/g, "").length;
		const wc = $("word-count");
		if (wc) wc.textContent = `共 ${len} 字`;
		setEditorMeta({
			words: len,
			chapterId: App.state.currentChapterId ?? null,
		});
	}

	function currentEdit() {
		return {
			title: $("chapter-title-input").value,
			content: $("chapter-content").value,
			beat: $("chapter-beat").value,
		};
	}

	function setEditDirty(v) {
		editDirty = v;
		const btn = $("btn-save-chapter");
		if (btn) {
			btn.classList.toggle("mode-on", v);
			btn.title = v ? "有未保存修改，停笔 3 秒后自动保存" : "";
		}
	}

	function markEditClean() {
		editBaseline = currentEdit();
		setEditDirty(false);
	}

	function checkEditDirty() {
		if (!editBaseline) return;
		const c = currentEdit();
		setEditDirty(
			c.title !== editBaseline.title ||
				c.content !== editBaseline.content ||
				c.beat !== editBaseline.beat,
		);
	}

	function onManualInput() {
		editGeneration += 1; // C02：输入即推进编辑代数，保存标干净要以此比对
		checkEditDirty();
		if (editDirty) scheduleAutoSave();
	}

	function scheduleAutoSave() {
		if (autoSaveTimer) clearTimeout(autoSaveTimer);
		autoSaveTimer = setTimeout(() => {
			autoSaveTimer = null;
			autoSaveNow();
		}, AUTO_SAVE_DELAY_MS);
	}

	async function autoSaveNow() {
		if (!editDirty || autoSaving || !App.state.currentChapterId) return;
		autoSaving = true;
		try {
			// §2.5.8 名义入口：与 legacy 的 BookPage.saveChapter 逐次等价（包装链触发）
			const ok = await chapterEditorApi().saveChapter(true);
			if (ok) App.toast("已自动保存");
		} finally {
			autoSaving = false;
		}
	}

	function clearEditState() {
		editBaseline = null;
		chapterRevision = null;
		setEditDirty(false);
	}

	// 离开提醒（:83-87）：脏且有当前章才拦
	function handleBeforeUnload(e) {
		if (!editDirty || !App.state.currentChapterId) return;
		e.preventDefault();
		e.returnValue = "";
	}

	// 分卷管理：编辑卷信息（含卷大纲）（:90-118）
	function volumeModal(vol) {
		App.openModal({
			title: vol ? "编辑分卷" : "新建分卷",
			bodyHTML:
				`<label class="field"><span>卷名</span><input id="vol-title" value="${App.escapeHtml(vol ? vol.title : "")}"></label>` +
				`<label class="field"><span>卷简介</span><textarea id="vol-intro" rows="2">${App.escapeHtml(vol ? vol.intro : "")}</textarea></label>` +
				`<label class="field"><span>卷大纲（AI 写作时会严格参考）</span><textarea id="vol-outline" rows="8" placeholder="本卷的阶段目标、关键事件、必须回收的伏笔…">${App.escapeHtml(vol ? vol.outline : "")}</textarea></label>`,
			onOk: async (body) => {
				const title = body.querySelector("#vol-title").value.trim();
				if (!title) {
					App.toast("请填写卷名");
					return false;
				}
				const payload = {
					title: title,
					intro: body.querySelector("#vol-intro").value.trim(),
					outline: body.querySelector("#vol-outline").value.trim(),
				};
				try {
					if (vol) {
						await App.api("PUT", `${volPath()}/${vol.id}`, payload);
					} else {
						await App.api("POST", volPath(), payload);
					}
					await chapterEditorApi().loadChapters();
				} catch (e) {
					App.toast(e.message);
					return false;
				}
			},
		});
	}

	// S1-06/C05：章节回收站（:137-149）
	function openChapterRecycleModal() {
		App.openModal({
			title: "章节回收站",
			bodyHTML:
				'<div id="chapter-recycle-list" class="recycle-list"><p class="empty-hint">加载中…</p></div>',
			onOk: () => {
				/* 仅关闭 */
			},
		});
		App.api("GET", recyclePath())
			.then((res) => {
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :144 兜底形态
				renderChapterRecycleList((res && res.items) || []);
			})
			.catch((e) => {
				const box = document.getElementById("chapter-recycle-list");
				if (box) {
					box.innerHTML = `<p class="empty-hint">加载失败：${App.escapeHtml(e.message)}</p>`;
				}
			});
	}

	function renderChapterRecycleList(items) {
		const box = document.getElementById("chapter-recycle-list");
		if (!box) return;
		if (!items.length) {
			box.innerHTML =
				'<p class="empty-hint">回收站是空的。删除章节时会自动保留正文与历史版本。</p>';
			return;
		}
		let html = "";
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			const volText = it.volume_title
				? `原属《${App.escapeHtml(it.volume_title)}》· `
				: it.volume_id
					? "原卷已删 · "
					: "";
			html +=
				`<div class="recycle-item" data-rec="${it.id}">` +
				`<div><strong>${App.escapeHtml(it.title)}</strong>` +
				`<small>${volText}${it.chars} 字 · ${it.versions} 个历史版本 · 删于 ${App.escapeHtml(String(it.deleted_at))}</small></div>` +
				`<button class="btn btn-primary btn-small" type="button" data-restore="${it.id}">恢复</button>` +
				"</div>";
		}
		box.innerHTML = html;
		box.onclick = (ev) => {
			const btn = ev.target.closest("[data-restore]");
			if (btn) restoreRecycledChapter(Number(btn.dataset.restore));
		};
	}

	async function restoreRecycledChapter(recycleId, volumeId) {
		try {
			const payload = {};
			if (volumeId === null) payload.volume_id = null;
			else if (volumeId !== undefined) payload.volume_id = volumeId;
			const res = await App.api(
				"POST",
				`${recyclePath()}/${recycleId}/restore`,
				payload,
			);
			App.toast(
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :182 兜底形态
				`已恢复《${(res.chapter && res.chapter.title) || ""}》，${res.reviewItems.length} 项待核对`,
			);
			App.closeModal();
			await chapterEditorApi().loadChapters();
			// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :185 守卫形态
			if (res.chapter && res.chapter.id) {
				chapterEditorApi().selectChapter(res.chapter.id);
			}
		} catch (e) {
			if (e && e.code === "VOLUME_REQUIRED") {
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :188 守卫形态
				promptRestoreVolume(recycleId, e.details && e.details.volumes);
			} else if (e && e.code === "RECYCLE_RECORD_NOT_FOUND") {
				App.toast(e.message);
				openChapterRecycleModal();
			} else {
				App.toast(e.message);
			}
		}
	}

	function promptRestoreVolume(recycleId, volumes) {
		let opts = "";
		for (let i = 0; i < (volumes || []).length; i++) {
			opts += `<option value="${volumes[i].id}">${App.escapeHtml(volumes[i].title)}</option>`;
		}
		App.openModal({
			title: "选择恢复到哪一卷",
			bodyHTML: `<p class="field-hint">该章原属的分卷已删除。选择目标卷，或恢复为未归卷稍后手动归卷。</p><label class="field"><span>目标卷</span><select id="recycle-target-volume"><option value="">未归卷（稍后手动归卷）</option>${opts}</select></label>`,
			okText: "恢复",
			onOk: (body) => {
				const sel = body.querySelector("#recycle-target-volume");
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :211 守卫形态
				const v = sel && sel.value ? Number(sel.value) : null;
				restoreRecycledChapter(recycleId, v);
				return false; // 成功路径里统一关闭弹窗
			},
		});
	}

	// 章节重命名（:221-267）：只提交 title，不动正文（服务端改标题不解除定稿）
	function chapterRenameModal(ch) {
		if (!ch) return;
		App.openModal({
			title: "重命名章节",
			bodyHTML: `<label class="field"><span>章节标题</span><input id="chapter-rename-title" maxlength="120" autocomplete="off" value="${App.escapeHtml(ch.title || "")}"></label><p class="field-hint">只改标题，不含正文；已定稿的章节改名不会解除定稿。</p>`,
			okText: "保存",
			onOk: async (body) => {
				const title = body.querySelector("#chapter-rename-title").value.trim();
				if (!title) {
					App.toast("请填写章节标题");
					return false;
				}
				try {
					// 改的是当前打开章且编辑器有未保存改动：先落库（:233-237）
					if (ch.id === App.state.currentChapterId && editDirty) {
						await chapterEditorApi().saveChapter(true);
					}
					// expected_revision：列表行可能是几秒前的快照（:238-242）
					const renameRev =
						ch.id === App.state.currentChapterId && chapterRevision != null
							? chapterRevision
							: Number(ch.revision);
					const putRes = await App.api("PUT", `${basePath()}/${ch.id}`, {
						title: title,
						expected_revision: renameRev,
					});
					if (ch.id === App.state.currentChapterId) {
						$("chapter-title-input").value = title;
						if (putRes && putRes.chapter && putRes.chapter.revision != null) {
							chapterRevision = Number(putRes.chapter.revision);
						}
						markEditClean();
					}
					await chapterEditorApi().loadChapters();
					App.toast("已重命名");
				} catch (e) {
					if (e && e.code === "CHAPTER_CONFLICT") {
						App.toast("该章已在别处被修改，列表已刷新，请确认标题后重试");
						await chapterEditorApi().loadChapters();
					} else {
						App.toast(e.message);
					}
					return false;
				}
			},
		});
	}

	// 目录加载（:269-433）：数据面逐字；渲染面 = 更新 React 模型 + emit
	async function loadChapters() {
		try {
			const volRes = await App.api("GET", volPath());
			const volumes = volRes.volumes || [];
			const res = await App.api("GET", basePath());
			const chapters = res.chapters || [];

			// 记录最新卷，供新建章节归属（:278-280）
			if (volumes.length && !App.state.currentVolumeId) {
				App.state.currentVolumeId = volumes[volumes.length - 1].id;
			}
			listModel = {
				volumes: volumes,
				chapters: chapters,
				version: listModel.version + 1,
			};
			emit();
		} catch (e) {
			App.toast(e.message);
		}
	}

	// 卷头交互：折叠/编辑/删除（:349-382）
	async function onVolumeRowClick(ev, vol) {
		if (ev.target.closest(".edit-vol")) {
			volumeModal(vol);
			return;
		}
		if (ev.target.closest(".del-vol")) {
			if (!confirm(`删除《${vol.title}》？卷内章节会移到其他卷`)) return;
			try {
				await App.api("DELETE", `${volPath()}/${vol.id}`);
				if (App.state.currentVolumeId === vol.id)
					App.state.currentVolumeId = null;
				// 清掉该卷的折叠记录：卷 id 会被 SQLite 复用（:363-365）
				collapseStore.expand(currentBookId(), vol.id);
				await refreshChapterRevision(App.state.currentChapterId);
				await chapterEditorApi().loadChapters();
			} catch (err) {
				App.toast(err.message);
			}
			return;
		}
		// 折叠/展开本卷章节（状态写入 collapseStore，供后续重渲染回放；:371-379）
		const collapsed = !collapseStore.isCollapsed(currentBookId(), vol.id);
		collapseStore.setCollapsed(currentBookId(), vol.id, collapsed);
		emit();
	}

	// 章节交互（:384-429）
	async function onChapterRowClick(ev, ch) {
		if (ev.target.closest(".edit-chapter")) {
			chapterRenameModal(ch);
			return;
		}
		if (ev.target.closest(".reindex-missing")) {
			// 一键补建缺失向量索引（:395-405）
			try {
				const r = await App.api("POST", `${basePath()}/reindex`, {});
				App.toast(
					r.missing > 0
						? `后台重建 ${r.missing} 章索引中…（模型冷加载可能需 10~30 秒，稍后列表自动刷新）`
						: "没有缺失的索引",
				);
				if (r.missing > 0) {
					setTimeout(() => {
						chapterEditorApi().loadChapters();
					}, 12000);
				}
			} catch (err) {
				App.toast(err.message);
			}
			return;
		}
		if (ev.target.closest(".open-read")) {
			window.location.hash = `#/book/${App.state.currentBook.id}/read/${ch.id}`;
			return;
		}
		if (ev.target.closest(".del-chapter")) {
			if (!confirm("删除该章节？正文与历史版本会进入回收站，可随时恢复。"))
				return;
			try {
				await App.api("DELETE", `${basePath()}/${ch.id}`);
				if (ch.id === App.state.currentChapterId) {
					App.state.currentChapterId = null;
					$("editor-body").classList.add("hidden");
					$("editor-empty").classList.remove("hidden");
					clearEditState();
				}
				await chapterEditorApi().loadChapters();
			} catch (err) {
				App.toast(err.message);
			}
			return;
		}
		chapterEditorApi().selectChapter(ch.id);
	}

	// ---------- C03/S1-05：离开闸门（切章/切书共用，:435-507） ----------
	function saveBeforeLeave() {
		if (!editDirty || !App.state.currentChapterId) return Promise.resolve(true);
		return chapterEditorApi()
			.saveChapter(true)
			.then((ok) => {
				return ok === true && !editDirty; // 保存期间又有新输入＝未保存完，继续拦
			});
	}

	function unsavedChangesModal(actions) {
		App.openModal({
			title: "有未保存的修改",
			bodyHTML:
				'<p class="field-hint">本章还有未落库的修改（保存失败，或保存期间又有新输入），已留在本章，编辑器内容原样保留。离开前请先落库，或明确选择放弃。</p>' +
				'<div class="conflict-actions">' +
				'<button class="btn btn-primary btn-small" type="button" data-act="retry">重试保存并继续</button> ' +
				'<button class="btn btn-outline btn-small" type="button" data-act="stay">留在本章</button> ' +
				'<button class="btn btn-outline btn-small" type="button" data-act="discard">放弃修改并继续</button>' +
				"</div>",
			okText: "留在本章",
			onOk: () => {
				/* 关闭即留下 */
			},
		});
		const box = document.querySelector("#modal-body .conflict-actions");
		if (!box) return;
		box.onclick = (ev) => {
			const btn = ev.target.closest("[data-act]");
			if (!btn) return;
			const act = btn.dataset.act;
			App.closeModal();
			if (act === "retry" && typeof actions.onRetry === "function")
				actions.onRetry();
			else if (act === "discard" && typeof actions.onDiscard === "function")
				actions.onDiscard();
			// stay：仅关闭弹窗
		};
	}

	function hasUnsavedChanges() {
		return !!(editDirty && App.state.currentChapterId);
	}

	// 作者明确放弃后由调用方调用：清脏放行，不再尝试保存（:475-478）
	function clearUnsaved() {
		clearEditState();
	}

	async function leaveGuard(actions) {
		if (await saveBeforeLeave()) return true;
		unsavedChangesModal(actions || {});
		return false;
	}

	async function selectChapter(cid) {
		if (cid !== App.state.currentChapterId) {
			const canLeave = await chapterEditorApi().leaveGuard({
				onRetry: () => {
					chapterEditorApi().selectChapter(cid);
				},
				onDiscard: () => {
					chapterEditorApi().clearUnsaved();
					chapterEditorApi().selectChapter(cid);
				},
			});
			if (!canLeave) return;
		}
		try {
			const res = await App.api("GET", `${basePath()}/${cid}`);
			const chapter = res.chapter;
			chapterRevision = Number.isFinite(Number(chapter.revision))
				? Number(chapter.revision)
				: null;
			App.state.currentChapterId = cid;
			App.state.currentVolumeId =
				chapter.volume_id || App.state.currentVolumeId;
			$("editor-empty").classList.add("hidden");
			$("editor-body").classList.remove("hidden");
			$("chapter-title-input").value = chapter.title || "";
			$("chapter-content").value = chapter.content || "";
			$("chapter-beat").value = chapter.beat || "";
			markEditClean();
			updateLockBtn(!!chapter.locked);
			updateRelockBanner(!!chapter.relock_pending);
			updateWordCount();
			if (chapter.summary) {
				$("summary-box").classList.remove("hidden");
				$("summary-text").textContent = chapter.summary;
			} else {
				$("summary-box").classList.add("hidden");
			}
			await chapterEditorApi().loadChapters();
			// 专注模式面包屑同步钩子（模块未加载时为空操作，:539-540）
			const fm = focusModeBridge();
			if (fm) fm.sync();
		} catch (e) {
			App.toast(e.message);
		}
	}

	// PUT 带 expected_revision：428 先读后写恰一次（:546-564）
	async function putChapterWithRevision(cid, body) {
		const payload = Object.assign({}, body);
		if (chapterRevision != null) payload.expected_revision = chapterRevision;
		try {
			return await finishSave(
				await App.api("PUT", `${basePath()}/${cid}`, payload),
				cid,
			);
		} catch (e) {
			if (
				e &&
				e.code === "CHAPTER_REVISION_REQUIRED" &&
				chapterRevision == null
			) {
				const fresh = await App.api("GET", `${basePath()}/${cid}`);
				chapterRevision = Number.isFinite(Number(fresh.chapter.revision))
					? Number(fresh.chapter.revision)
					: null;
				if (chapterRevision == null) throw e;
				payload.expected_revision = chapterRevision;
				return await finishSave(
					await App.api("PUT", `${basePath()}/${cid}`, payload),
					cid,
				);
			}
			throw e;
		}
	}

	// 保存成功后刷新版本快照（:566-572）
	async function finishSave(res, cid) {
		if (
			res &&
			res.chapter &&
			res.chapter.revision != null &&
			cid === App.state.currentChapterId
		) {
			chapterRevision = Number(res.chapter.revision);
		}
		return res;
	}

	// 409/428 冲突：拉服务端最新版弹显式二选一（:574-604）
	async function showChapterConflict(cid, local) {
		let fresh;
		try {
			fresh = await App.api("GET", `${basePath()}/${cid}`);
		} catch (e2) {
			App.toast(
				`获取服务端最新版本失败：${e2.message}（本地稿已保留，可先手动复制）`,
			);
			return;
		}
		if (showConflictDialog) {
			showConflictDialog({
				server: fresh.chapter,
				local: local,
				onReload: (srv) => {
					if (cid !== App.state.currentChapterId) return; // 弹窗期间已切章：不动编辑器
					$("chapter-title-input").value = srv.title || "";
					$("chapter-content").value = srv.content || "";
					$("chapter-beat").value = srv.beat || "";
					chapterRevision = Number.isFinite(Number(srv.revision))
						? Number(srv.revision)
						: null;
					markEditClean();
					updateWordCount();
					updateLockBtn(!!srv.locked);
					updateRelockBanner(!!srv.relock_pending);
					chapterEditorApi().loadChapters();
				},
			});
		} else {
			App.toast("章节已在别处被修改，本地稿已保留在编辑器中，请核对后重试");
		}
	}

	// 轻量重读刷新快照（:606-618）
	async function refreshChapterRevision(cid) {
		if (cid == null || cid !== App.state.currentChapterId) return;
		try {
			const res = await App.api("GET", `${basePath()}/${cid}`);
			// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :612 守卫形态
			if (res && res.chapter) {
				chapterRevision = Number.isFinite(Number(res.chapter.revision))
					? Number(res.chapter.revision)
					: null;
				updateLockBtn(!!res.chapter.locked);
				updateRelockBanner(!!res.chapter.relock_pending);
			}
		} catch (_e) {
			/* 静默：快照刷新失败不阻断主流程，版本不符仍有 409 冲突兜底 */
		}
	}

	// 保存单飞＋pending 补发（:623-650，5c779b9 契约，不得简化）
	async function saveChapter(quiet) {
		if (!App.state.currentChapterId) return false;
		if (saveInFlight) {
			savePendingRetry = true;
			return saveInFlight;
		}
		saveInFlight = chapterEditorApi()._doSaveChapter(quiet);
		let ok;
		try {
			ok = await saveInFlight;
		} finally {
			saveInFlight = null;
		}
		while (savePendingRetry) {
			savePendingRetry = false;
			if (!ok || !editDirty || !App.state.currentChapterId) break;
			saveInFlight = chapterEditorApi()._doSaveChapter(true);
			try {
				ok = await saveInFlight;
			} finally {
				saveInFlight = null;
			}
		}
		return ok;
	}

	async function _doSaveChapter(quiet) {
		if (!App.state.currentChapterId) return false;
		// legacy :655 `var cid` 在 try 内声明但 hoist 到函数作用域（catch 分支 :690-697 也读它）——
		// ES module 里必须显式提到 try 之前，否则 catch 引用未定义
		const cid = App.state.currentChapterId;
		try {
			const bookIdAtSubmit = App.state.currentBook.id;
			const submittedGeneration = editGeneration;
			const title = $("chapter-title-input").value.trim() || "未命名";
			const content = $("chapter-content").value;
			const beat = $("chapter-beat").value.trim();
			const res = await putChapterWithRevision(cid, {
				title: title,
				content: content,
				beat: beat,
			});
			// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :662 守卫形态
			if (res && res.autoUnlocked) {
				updateLockBtn(false);
				updateRelockBanner(true);
				App.toast("该章原定稿，修改后已自动解除定稿");
			} else if (!quiet) {
				App.toast("已保存");
			}
			// C02/S1-04 标干净三条件：同一书章 + 持久化成功 + 保存期间无新输入（:669-678）
			const durable =
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :672 持久化契约校验形态
				!(res && res.persistence) || res.persistence.durable !== false;
			if (
				durable &&
				cid === App.state.currentChapterId &&
				bookIdAtSubmit === App.state.currentBook.id &&
				submittedGeneration === editGeneration
			) {
				markEditClean();
			}
			await chapterEditorApi().loadChapters();
			return true;
		} catch (e) {
			if (e && e.code === "PERSISTENCE_PENDING") {
				// S1-01 契约：业务已应用但未落盘（:682-689）
				App.toast(
					"内容已保存到内存，磁盘暂不可用，系统正在自动重试落盘；请勿关闭页面",
				);
				await refreshChapterRevision(cid);
				return false;
			}
			if (
				e &&
				(e.code === "CHAPTER_CONFLICT" ||
					e.code === "CHAPTER_REVISION_REQUIRED")
			) {
				await showChapterConflict(cid, {
					title: $("chapter-title-input").value,
					content: $("chapter-content").value,
					beat: $("chapter-beat").value,
				});
				return false;
			}
			App.toast(e.message);
			return false;
		}
	}

	// 定稿按钮状态（:703-709）
	function updateLockBtn(locked) {
		const btn = $("btn-lock-chapter");
		if (!btn) return;
		btn.textContent = locked ? "解除定稿" : "定稿";
		btn.classList.toggle("mode-on", locked);
		setEditorMeta({ locked });
	}

	// 「定稿后被修改」警示条（:711-716）
	function updateRelockBanner(show) {
		const banner = $("relock-banner");
		if (!banner) return;
		banner.classList.toggle("hidden", !show);
		setEditorMeta({ relock: !!show });
	}

	async function toggleLock() {
		if (!App.state.currentChapterId) return;
		const cid = App.state.currentChapterId;
		const locked = $("btn-lock-chapter").classList.contains("mode-on");
		if (locked) {
			try {
				await App.api("POST", `${basePath()}/${cid}/unlock`);
				updateLockBtn(false);
				App.toast("已解除定稿，向量索引已移除");
				await refreshChapterRevision(cid); // 解锁会递增 revision，刷新快照
				await chapterEditorApi().loadChapters();
			} catch (e) {
				App.toast(e.message);
			}
			return;
		}
		await doRelock("已定稿，后台建立向量索引中");
	}

	// 保存最新内容后定稿并重建语义索引（:735-748）
	async function doRelock(toastText) {
		const cid = App.state.currentChapterId;
		if (!cid) return;
		await chapterEditorApi().saveChapter(true);
		try {
			await App.api("POST", `${basePath()}/${cid}/lock`);
			updateLockBtn(true);
			updateRelockBanner(false);
			App.toast(toastText);
			await refreshChapterRevision(cid); // 重新定稿会递增 revision，刷新快照
			await chapterEditorApi().loadChapters();
		} catch (e) {
			App.toast(e.message);
		}
	}

	// ---------- 编辑器绑定族（:750-937） ----------
	// 说明：编辑器壳节点由 React 渲染（同 id 常驻），此处按 legacy 原样做命令式 onclick/
	// addEventListener 绑定；React 不渲染这些事件 props，重渲染不会清掉已绑监听。
	function bindChapterEvents() {
		const tabs = document.querySelectorAll(".tab[data-tab]");
		for (let i = 0; i < tabs.length; i++) {
			tabs[i].onclick = function () {
				const tab = this.getAttribute("data-tab");
				const allTabs = document.querySelectorAll(".tab[data-tab]");
				for (let k = 0; k < allTabs.length; k++) {
					allTabs[k].classList.remove("active");
				}
				this.classList.add("active");
				const panels = [
					"tab-chapters",
					"tab-outline",
					"tab-state",
					"tab-world",
					"tab-characters",
				];
				for (let m = 0; m < panels.length; m++) {
					const panel = $(panels[m]);
					if (panel) {
						if (panels[m] === `tab-${tab}`) panel.classList.remove("hidden");
						else panel.classList.add("hidden");
					}
				}
			};
		}

		$("btn-add-chapter").onclick = async () => {
			try {
				const payload = {};
				if (App.state.currentVolumeId)
					payload.volume_id = App.state.currentVolumeId;
				const res = await App.api("POST", basePath(), payload);
				const chapter = res.chapter;
				// 新章节若落在被折叠的卷里：只展开这一卷（:780-781）
				if (chapter.volume_id)
					collapseStore.expand(currentBookId(), chapter.volume_id);
				await chapterEditorApi().loadChapters();
				await chapterEditorApi().selectChapter(chapter.id);
			} catch (e) {
				App.toast(e.message);
			}
		};

		$("btn-add-volume").onclick = () => {
			volumeModal(null);
		};

		$("btn-chapter-recycle").onclick = openChapterRecycleModal;

		$("btn-open-read").onclick = () => {
			const cid = App.state.currentChapterId;
			window.location.hash = `#/book/${App.state.currentBook.id}/read${cid ? `/${cid}` : ""}`;
		};

		// 编辑器底部「进入精修」大按钮（:800-805）
		$("btn-enter-refine").onclick = () => {
			const cid = App.state.currentChapterId;
			if (!cid) {
				App.toast("先在左侧选择或新建一个章节");
				return;
			}
			window.location.hash = `#/book/${App.state.currentBook.id}/read/${cid}`;
		};

		$("btn-save-chapter").onclick = () => {
			chapterEditorApi().saveChapter();
		};

		$("btn-relock").onclick = () => {
			doRelock("已重新定稿，后台重建语义索引中");
		};
		$("btn-lock-chapter").onclick = toggleLock;

		const contentEl = $("chapter-content");
		if (!contentEl.dataset.bound) {
			contentEl.addEventListener("input", () => {
				updateWordCount();
				onManualInput();
			});
			contentEl.dataset.bound = "1";
		}
		const titleEl = $("chapter-title-input");
		if (!titleEl.dataset.bound) {
			titleEl.addEventListener("input", onManualInput);
			titleEl.dataset.bound = "1";
		}
		const beatEl = $("chapter-beat");
		if (!beatEl.dataset.bound) {
			beatEl.addEventListener("input", onManualInput);
			beatEl.dataset.bound = "1";
		}

		$("btn-gen-summary").onclick = async function () {
			if (!App.state.currentChapterId) return;
			try {
				await chapterEditorApi().saveChapter(true);
				this.disabled = true;
				this.textContent = "生成中…";
				const cid = App.state.currentChapterId;
				const res = await App.api("POST", `${basePath()}/${cid}/summary`);
				$("summary-box").classList.remove("hidden");
				$("summary-text").textContent = res.summary;
				await refreshChapterRevision(cid); // 写入总结会递增 revision，刷新快照
				await chapterEditorApi().loadChapters();
			} catch (e) {
				App.toast(e.message);
			} finally {
				this.disabled = false;
				this.textContent = "生成总结";
			}
		};

		// ---------- 润色（:857-930） ----------
		function polishModal(scope, selectedText, selStart, selEnd) {
			App.openModal({
				title: scope === "selection" ? "润色选中段落" : "润色本章",
				bodyHTML:
					'<label class="field"><span>润色要求（可选）</span>' +
					'<input id="polish-req" placeholder="如：加强画面感 / 删减冗余 / 对话更自然"></label>',
				okText: "开始润色",
				onOk: async (body) => {
					const requirement = body.querySelector("#polish-req").value.trim();
					const cid = App.state.currentChapterId;
					if (!cid) {
						App.toast("请先选择章节");
						return false;
					}
					await chapterEditorApi().saveChapter(true); // 先保存，保证润色基于最新内容
					App.toast("润色中…");
					try {
						const payload = { scope: scope, requirement: requirement };
						if (scope === "selection") payload.selected_text = selectedText;
						const res = await App.api(
							"POST",
							`${basePath()}/${cid}/polish`,
							payload,
						);
						const original =
							scope === "selection" ? selectedText : $("chapter-content").value;
						showDiff({
							scope: scope,
							original: original,
							polished: res.polished,
							onAccept: async (polished) => {
								const c = $("chapter-content");
								if (scope === "selection") {
									// 润色是网络往返，期间正文可能被再次编辑：快照偏移与原文不符时回退重定位
									let sStart = selStart;
									let sEnd = selEnd;
									if (c.value.slice(sStart, sEnd) !== selectedText) {
										const idx = c.value.indexOf(selectedText);
										if (idx < 0) {
											App.toast(
												"正文中已找不到选中段落，润色结果未应用（正文已被改动）",
											);
											return;
										}
										sStart = idx;
										sEnd = idx + selectedText.length;
									}
									c.value =
										c.value.slice(0, sStart) + polished + c.value.slice(sEnd);
								} else {
									c.value = polished;
								}
								updateWordCount();
								await chapterEditorApi().saveChapter(true);
								App.toast("已采纳润色并保存");
							},
						});
					} catch (e) {
						App.toast(e.message);
						return false;
					}
				},
			});
		}

		// 整章润色（:908-913）
		$("btn-polish-chapter").onclick = () => {
			if (!App.state.currentChapterId) return;
			if (!$("chapter-content").value.trim()) {
				App.toast("章节内容为空");
				return;
			}
			polishModal("chapter");
		};

		// 选中段落润色：监听选区（:915-930）
		if (!contentEl.dataset.selBound) {
			const checkSel = () => {
				const btn = $("btn-polish-selection");
				const has = contentEl.selectionStart < contentEl.selectionEnd;
				btn.classList.toggle("hidden", !has);
			};
			contentEl.addEventListener("mouseup", checkSel);
			contentEl.addEventListener("keyup", checkSel);
			contentEl.dataset.selBound = "1";
		}
		$("btn-polish-selection").onclick = () => {
			const s = contentEl.selectionStart;
			const e = contentEl.selectionEnd;
			if (s >= e) return;
			polishModal("selection", contentEl.value.slice(s, e), s, e);
		};

		// diff 视图按钮（幂等绑定，:932-936）
		if (!diffIsBound()) {
			bindDiff();
			markDiffBound();
		}
	}

	// S4-03：正文编辑器的离开闸门注册进统一导航守卫（:486-507）
	// P6-2：守卫单例直取（等值旧 `window.WorkspaceState && …registerGuard` 真值守卫——
	// 该守卫在生产恒真，属不可达差异）
	getWorkspaceState().registerGuard({
		key: "writing-editor",
		label: "正文编辑器",
		isDirty: () => chapterEditorApi().hasUnsavedChanges(),
		discard: () => chapterEditorApi().clearUnsaved(),
		leave: (ctx) => {
			const actions = ctx || {};
			return chapterEditorApi().leaveGuard({
				onRetry: actions.retry,
				onDiscard: () => {
					chapterEditorApi().clearUnsaved(); // 放弃必须作者点击：清脏由 clearUnsaved 显式完成
					if (typeof actions.discard === "function") actions.discard();
				},
			});
		},
	});

	return {
		listEl,
		getListModel: () => listModel,
		subscribe: (fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		isVolumeCollapsed: (volId) =>
			collapseStore.isCollapsed(currentBookId(), volId),
		isActiveChapter: (id) => id === App.state.currentChapterId,
		bookId: () => currentBookId(),
		currentChapterId: () => App.state.currentChapterId,
		getEditorMeta: () => editorMeta,
		subscribeEditorMeta: (fn) => {
			metaListeners.add(fn);
			return () => metaListeners.delete(fn);
		},
		onVolumeRowClick,
		onChapterRowClick,
		handleBeforeUnload,
		// 8 名旧名方法（与 legacy BookPage.* 逐名对应；_doSaveChapter 必须在列——单飞内部经它调用）
		// P6-1：仅 saveChapter／selectChapter 经 withWritingStatusRefresh 包住（等值已退役的
		// wrapStatusRefresh 链，触发集＝名义入口调用点）；其余 6 名不包——_doSaveChapter／
		// loadChapters 等内部路径今日不刷，迁移后亦不得新增（Plan §2.5 对照表）。
		api: {
			loadChapters,
			selectChapter: withWritingStatusRefresh(selectChapter),
			saveChapter: withWritingStatusRefresh(saveChapter),
			_doSaveChapter,
			hasUnsavedChanges,
			clearUnsaved,
			leaveGuard,
			bindChapterEvents,
		},
	};
}

// ---------- React 渲染面 ----------
// 目录行：等价 legacy :282-346 的 innerHTML 整表（同一 controller 的两处渲染面之一）
function ChapterRow({ ch, volId, collapsed, controller, target }) {
	const active = controller.isActiveChapter(ch.id);
	let lockBadge = null;
	if (ch.locked) {
		lockBadge = (
			<>
				<span
					className="lock-badge"
					title={`已定稿${ch.locked_at ? `（${ch.locked_at}）` : ""}：内容已进入向量检索`}
				>
					定稿
				</span>
				{ch.indexed ? null : (
					// biome-ignore lint/a11y/useSemanticElements: 等值 legacy :315 的 span.lock-badge[role=button]（innerHTML 原样，样式依赖 .lock-badge）
					// biome-ignore lint/a11y/useFocusableInteractive: 等值 legacy :315——重新定稿入口是整行 li 的鼠标点击，不新增键盘语义（行为零变化红线）
					<span
						className="lock-badge reindex-missing"
						title="已定稿但向量索引缺失：AI 语义检索找不到这章。点击重建"
						role="button"
					>
						索引缺失·点此重建
					</span>
				)}
			</>
		);
	} else if (ch.relock_pending) {
		lockBadge = (
			<span
				className="lock-badge relock"
				title="本章曾定稿，正文已修改：语义检索暂停覆盖，请核对后重新定稿"
			>
				待重定稿
			</span>
		);
	}
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: 等值 legacy :390 的 li.onclick 纯鼠标交互（行内四按钮各自处理），不加键盘语义
		<li
			className={`item-row chapter-row${active ? " active" : ""}`}
			data-id={ch.id}
			data-vol={volId}
			style={collapsed ? { display: "none" } : undefined}
			onClick={(ev) => controller.onChapterRowClick(ev, ch)}
		>
			<span className={`summary-dot${ch.summary ? "" : " none"}`}></span>
			<span className="item-name">{ch.title}</span>
			{ch.drift_status === "minor" || ch.drift_status === "major" ? (
				<span
					className={`drift-badge ${ch.drift_status}`}
					title={ch.drift_note || ""}
				>
					{ch.drift_status === "major" ? "严重偏离" : "轻度偏离"}
				</span>
			) : null}
			{lockBadge}
			<ChapterRowMeta ch={ch} target={target} />
			<span className="item-ops">
				<button
					className="icon-btn edit-chapter"
					title="重命名本章"
					type="button"
				>
					✎
				</button>
				<button
					className="icon-btn open-read"
					title="在阅读/精修页打开本章"
					type="button"
				>
					读
				</button>
				<button className="icon-btn del-chapter" type="button">
					×
				</button>
			</span>
		</li>
	);
}

function OrphanChapterRow({ ch, controller, target }) {
	const active = controller.isActiveChapter(ch.id);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: 等值 legacy :390 的 li.onclick 纯鼠标交互，不加键盘语义
		<li
			className={`item-row chapter-row${active ? " active" : ""}`}
			data-id={ch.id}
			data-vol=""
			onClick={(ev) => controller.onChapterRowClick(ev, ch)}
		>
			<span className={`summary-dot${ch.summary ? "" : " none"}`}></span>
			<span className="item-name">{ch.title}</span>
			{ch.locked ? (
				<span className="lock-badge" title="已定稿">
					定稿
				</span>
			) : null}
			{ch.locked && !ch.indexed ? (
				// biome-ignore lint/a11y/useSemanticElements: 等值 legacy :342 的 span.lock-badge[role=button]（innerHTML 原样，样式依赖 .lock-badge）
				// biome-ignore lint/a11y/useFocusableInteractive: 等值 legacy :342——补建索引入口是整行 li 的鼠标点击，不新增键盘语义
				<span
					className="lock-badge reindex-missing"
					title="已定稿但向量索引缺失，点击重建"
					role="button"
				>
					索引缺失
				</span>
			) : null}
			<ChapterRowMeta ch={ch} target={target} />
			<span className="item-ops">
				<button
					className="icon-btn edit-chapter"
					title="重命名本章"
					type="button"
				>
					✎
				</button>
				<button
					className="icon-btn open-read"
					title="在阅读/精修页打开本章"
					type="button"
				>
					读
				</button>
				<button className="icon-btn del-chapter" title="删除章节" type="button">
					×
				</button>
			</span>
		</li>
	);
}

function DirectoryRows({ model, controller, filter = "all", target }) {
	const volumeIds = {};
	for (const vol of model.volumes) volumeIds[vol.id] = true;
	const orphanChapters = model.chapters.filter(
		(c) =>
			(!c.volume_id || !volumeIds[c.volume_id]) &&
			matchesChapterFilter(c, filter),
	);
	const rows = [];
	for (const vol of model.volumes) {
		const allInVol = model.chapters.filter((c) => c.volume_id === vol.id);
		const volChapters = allInVol.filter((c) => matchesChapterFilter(c, filter));
		// 筛选时没有命中章节的卷整卷隐去；「全部」下空卷照常显示（卷头是建章/编辑卷的入口）
		if (filter !== "all" && !volChapters.length) continue;
		const volWords = allInVol.reduce((sum, c) => sum + chapterWords(c), 0);
		const collapsed = controller.isVolumeCollapsed(vol.id);
		rows.push(
			// biome-ignore lint/a11y/useKeyWithClickEvents: 等值 legacy :353 的卷头 li.onclick 纯鼠标交互（编辑/删除/折叠三态），不加键盘语义
			<li
				key={`vol-${vol.id}`}
				className={`volume-row${collapsed ? " collapsed" : ""}`}
				data-vol={vol.id}
				onClick={(ev) => controller.onVolumeRowClick(ev, vol)}
			>
				<span className="vol-toggle">{collapsed ? "▸" : "▾"}</span>
				<span className="vol-name">{vol.title}</span>
				{vol.summary_stale ? (
					<span
						className="vol-stale"
						title="卷内章节总结已变化，本卷总结基于旧内容生成，建议重新生成"
					>
						总结过期
					</span>
				) : null}
				<span className="vol-count">{volChapters.length} 章</span>
				<span className="vol-words" title="本卷约计字数">
					{formatWordCount(volWords)}
				</span>
				<span className="item-ops">
					<button
						className="icon-btn edit-vol"
						type="button"
						title="编辑卷信息/大纲"
					>
						✎
					</button>
					<button className="icon-btn del-vol" type="button" title="删除分卷">
						×
					</button>
				</span>
			</li>,
		);
		for (const ch of volChapters) {
			rows.push(
				<ChapterRow
					key={`ch-${ch.id}`}
					ch={ch}
					volId={vol.id}
					collapsed={collapsed}
					controller={controller}
					target={target}
				/>,
			);
		}
	}
	// 未归卷/悬空卷章节兜底（:324-346）
	if (orphanChapters.length) {
		rows.push(
			<li
				key="orphan-volume"
				className="volume-row orphan-volume-row"
				title="这些章节未归属任何现有分卷（可能是跨书挂卷或卷删除残留），可在编辑器中打开，建议重新归卷"
			>
				<span className="vol-name">未归卷</span>
				<span className="vol-count">{orphanChapters.length} 章</span>
				<span className="item-ops"></span>
			</li>,
		);
		for (const ch of orphanChapters) {
			rows.push(
				<OrphanChapterRow
					key={`orphan-${ch.id}`}
					ch={ch}
					controller={controller}
					target={target}
				/>,
			);
		}
	}
	return rows;
}

// 编辑器壳：与 index.html 的 #editor-body 静态壳 id 顺序/tag/class 一致（命令式代码与样式表同源依赖）。
// 常量 props ⇒ React 重渲染不重写被命令式改过的 class/text/value。
// UI 优化阶段 2（样稿 B）：工具条（状态徽章/字数进度/操作）置顶、正文区成为居中文档；
// EditorMeta / EditorEyebrow / AppearanceMenu 是自带订阅的展示件，不碰这些命令式节点。
// 唯一属性差异：静态壳中 7 个按钮无 type（DOM 默认 submit）而此处补 type="button"——两处均不在
// <form> 内（index.html :176-217 无 form 祖先），全仓零代码读取这些按钮的 .type，行为零变化；
// 补该属性是 biome lint/a11y/useButtonType 零诊断要求（S5-1/既有组件同规）。
function EditorShell({ controller }) {
	return (
		<>
			<div id="diff-view" className="diff-view hidden">
				<div className="diff-head">
					<span className="pane-title">
						润色对比 <span id="diff-scope" className="diff-scope"></span>
					</span>
					<span className="diff-actions">
						<button
							id="btn-diff-reject"
							className="btn btn-small btn-ghost"
							type="button"
						>
							放弃
						</button>
						<button
							id="btn-diff-accept"
							className="btn btn-small btn-primary"
							type="button"
						>
							采纳润色
						</button>
					</span>
				</div>
				{/* #diff-body：React 不写 children 的叶容器（MozhenDiffView.show 的命令式 root 宿主） */}
				<div id="diff-body" className="diff-body"></div>
			</div>
			<div className="editor-toolbar">
				<EditorMeta controller={controller} />
				<div className="editor-actions">
					<button
						id="btn-polish-chapter"
						className="btn btn-small btn-outline"
						type="button"
					>
						润色本章
					</button>
					<button
						id="btn-gen-summary"
						className="btn btn-small btn-outline"
						type="button"
					>
						生成总结
					</button>
					<button id="btn-save-chapter" className="btn btn-small" type="button">
						保存
					</button>
					<button
						id="btn-enter-refine"
						className="btn btn-small refine-btn"
						type="button"
						title="在阅读/精修页打开本章，逐段打磨字句"
					>
						精修
					</button>
					<button
						id="btn-lock-chapter"
						className="btn btn-small btn-outline"
						type="button"
						title="定稿：作者确认本章不再修改，定稿后内容才会进入向量检索（供 AI 召回旧剧情细节）"
					>
						定稿
					</button>
					<AppearanceMenu />
				</div>
			</div>
			<div id="relock-banner" className="relock-banner hidden">
				<span>
					本章曾定稿，正文已修改：语义检索已暂停覆盖本章。核对内容后可重新定稿。
				</span>
				<button
					id="btn-relock"
					className="btn btn-small btn-outline"
					type="button"
				>
					重新定稿
				</button>
			</div>
			<div className="editor-canvas">
				<div className="editor-doc">
					<EditorEyebrow controller={controller} />
					<div className="editor-head">
						<input
							id="chapter-title-input"
							className="chapter-title-input"
							type="text"
							placeholder="章节标题"
						/>
					</div>
					<label className="chapter-beat-box">
						<span className="chapter-beat-label">节拍</span>
						<input
							id="chapter-beat"
							className="chapter-beat"
							type="text"
							placeholder="本章节拍（可选）：本章必须完成的剧情节点，AI 写作时会参考"
						/>
					</label>
					<textarea
						id="chapter-content"
						className="chapter-content"
						placeholder="在这里写作，或从对话中插入 AI 生成的内容…"
					></textarea>
					<ContinuePreview controller={controller} />
					<div className="editor-foot">
						<button
							id="btn-polish-selection"
							className="btn btn-small btn-ghost hidden"
							type="button"
						>
							润色选中段落
						</button>
						<span id="word-count" className="word-count"></span>
					</div>
					<div id="summary-box" className="summary-box hidden">
						<div className="summary-label">
							本章总结{" "}
							<span className="summary-hint">
								（AI 写下一章时会参考，防止剧情漂移）
							</span>
						</div>
						<p id="summary-text"></p>
					</div>
				</div>
			</div>
		</>
	);
}

function ChapterEditorPanel({ controller, chrome = {} }) {
	const [model, setModel] = useState(() => controller.getListModel());
	const [filter, setFilter] = useState("all");
	const prefs = useWritingPrefs();
	useEffect(() => controller.subscribe(setModel), [controller]);
	const bookId = controller.bookId?.();
	const target = getChapterTarget(bookId, prefs);
	return (
		<>
			{controller.listEl
				? createPortal(
						<DirectoryRows
							model={model}
							controller={controller}
							filter={filter}
							target={target}
						/>,
						controller.listEl,
					)
				: null}
			{chrome.filterEl
				? createPortal(
						<ChapterFilterBar
							chapters={model.chapters}
							filter={filter}
							onChange={setFilter}
						/>,
						chrome.filterEl,
					)
				: null}
			{chrome.totalEl
				? createPortal(
						model.chapters.length ? ` · ${model.chapters.length}` : null,
						chrome.totalEl,
					)
				: null}
			{chrome.footEl
				? createPortal(
						<ChapterFoot
							chapters={model.chapters}
							bookId={bookId}
							target={target}
						/>,
						chrome.footEl,
					)
				: null}
			<EditorShell controller={controller} />
		</>
	);
}

// ---------- 旧名桥目标（legacy-bridge.jsx 只写 window.MozhenChapterEditor；禁写 window.BookPage） ----------
let currentApi = null;

const NULL_API = {
	async loadChapters() {},
	async selectChapter() {},
	async saveChapter() {
		return false;
	},
	async _doSaveChapter() {
		return false;
	},
	hasUnsavedChanges() {
		return false;
	},
	clearUnsaved() {},
	async leaveGuard() {
		return true;
	},
	bindChapterEvents() {},
};

export function chapterEditorApi() {
	return currentApi || NULL_API;
}

// 跨挂载根订阅编辑器状态（章号/字数/定稿态）：聊天面的「本章上下文」随切章刷新
let currentController = null;
export function subscribeEditorMeta(fn) {
	return currentController
		? currentController.subscribeEditorMeta(fn)
		: () => {};
}
export function getEditorMetaSnapshot() {
	return currentController ? currentController.getEditorMeta() : null;
}
export function getEditorListModel() {
	return currentController
		? currentController.getListModel()
		: { volumes: [], chapters: [], version: 0 };
}

// 自挂载（registerLegacyBridges 调用；容器缺失 no-op；同元素幂等——壳节点常驻不卸载）
export function mountChapterEditor() {
	if (typeof window === "undefined") return null;
	const editorBody = document.getElementById("editor-body");
	const listEl = document.getElementById("chapter-list");
	if (!getApp() || !editorBody || !listEl) return null;
	if (editorBody.__mozhenChapterEditorRoot) return currentApi;
	const controller = createChapterEditorController({ listEl });
	const root = createRoot(editorBody);
	editorBody.__mozhenChapterEditorRoot = root;
	currentApi = controller.api;
	currentController = controller;
	// P6-2（Plan §2.5-D2）：把编辑器脏标记接入 lib 供给缝——等值 run-status.js:238-239 读
	// `chapterEditorApi().hasUnsavedChanges?.()`（该名此前由本文件的 api 承接）；去全局后由本缝供给。
	bindEditorDirtyProvider(() => chapterEditorApi().hasUnsavedChanges());
	installBeforeUnload(controller);
	// 首挂 flushSync：保证 show() 内后续 bindStatusInputs()/selectChapter() 见到的已是 React 节点
	const chrome = {
		filterEl: document.getElementById("chapter-filter"),
		totalEl: document.getElementById("chapter-total"),
		footEl: document.getElementById("chapter-foot"),
	};
	flushSync(() => {
		root.render(<ChapterEditorPanel controller={controller} chrome={chrome} />);
	});
	return currentApi;
}

// beforeunload 单例（模块级一个 handler，重挂时指向最新 controller）
let beforeUnloadHandler = null;
function installBeforeUnload(controller) {
	if (beforeUnloadHandler) {
		window.removeEventListener("beforeunload", beforeUnloadHandler);
	}
	beforeUnloadHandler = (e) => controller.handleBeforeUnload(e);
	window.addEventListener("beforeunload", beforeUnloadHandler);
}

export default ChapterEditorPanel;
