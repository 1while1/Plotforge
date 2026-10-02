// S5-8（Plan §1.1 G4）：public/legacy/agent.js 块一「讨论结论 → 规划笔记 / 显式交接」的流程执行
// （范式 A·判定 C 的「块一建设笔」，零生产切换；S5-9 的 workspace 装配 hook 负责拉取/渲染编排）。
// 语义逐字对应 legacy 行号：:767-806 存笔记、:900-939 打开后弹窗内绑定、
// :941-965 建草案、:967-1010 提交草案、:1012-1021 预览、:1054-1107 预览弹窗三按钮、
// :1110-1144 作废、:1147-1184 接受（唯一写入点）。
// 纪律：api／toast／openModal／closeModal／escapeHtml／storage／confirm 全注入；本 hook 零 fetch、
// 零全局写入；弹窗继续走 App.openModal（#modal-body id 契约，Modal.jsx:4-12），打开后同步命令式
// 绑定预览三按钮（等值 legacy :1099-1106）。纯逻辑与 bodyHTML 在 lib/agent-handoff.js。
// 说明：legacy 的 `a && a.b ? a.b : c` / `!a || !a.b` 布尔链按源码逐字保留（charter §2 S4-3 不等价
// 教训：可选链会把 null 变 undefined），故以行内 suppression 压制 useOptionalChain 告警、不改写法。
import { useRef, useState } from "react";
import {
	defaultTargetId,
	handoffComposeBodyHTML,
	handoffDoneBodyHTML,
	handoffPreviewBodyHTML,
	handoffTargetHint,
	noteModalBodyHTML,
	writingOptions,
} from "../lib/agent-handoff.js";
import { scopeBookTitle } from "../lib/agent-scope.js";

export function useAgentHandoff(deps) {
	const d = deps || {};
	const noteRef = useRef(null);
	const [lastPlanningNote, setLastPlanningNote] = useState(null);
	const submittingRef = useRef(false);
	const acceptingRef = useRef(false);
	const cancellingRef = useRef(false);

	function toast(message) {
		if (typeof d.toast === "function") d.toast(message);
	}

	function escapeHtml(value) {
		return typeof d.escapeHtml === "function"
			? d.escapeHtml(value)
			: String(value == null ? "" : value);
	}

	function openModal(opts) {
		if (typeof d.openModal === "function") d.openModal(opts);
	}

	function closeModal() {
		if (typeof d.closeModal === "function") d.closeModal();
	}

	// legacy :902／:968-969／:981／:986／:1100 同款守卫（body && body.querySelector）的等值提取：
	// body 缺失或缺 querySelector 时一律 null，调用方早退路径不变。
	function pickIn(body, selector) {
		if (!body) return null;
		if (typeof body.querySelector !== "function") return null;
		return body.querySelector(selector);
	}

	function modalBody() {
		if (typeof document === "undefined") return null;
		return document.getElementById("modal-body");
	}

	// :809-814
	async function loadWritingConversations(bookId) {
		try {
			const list = await d.api(
				"GET",
				`/api/conversations?kind=writing&bookId=${encodeURIComponent(bookId)}`,
			);
			return Array.isArray(list) ? list : [];
		} catch (_e) {
			return [];
		}
	}

	// :900-939（打开后按「是否有目标书选择器」分流；全局范围选书→查该书写作会话，且不自动挑会话）
	function bindHandoffCompose(s, books) {
		const body = modalBody();
		if (!body) return;
		const targetSel = pickIn(body, "#handoff-target-conversation");
		if (targetSel && s.targetId) targetSel.value = s.targetId;
		if (s.bookScope) return;
		const bookSel = pickIn(body, "#handoff-target-book");
		if (!bookSel) return;
		bookSel.addEventListener("change", async () => {
			const hint = pickIn(body, "#handoff-target-hint");
			const sel = pickIn(body, "#handoff-target-conversation");
			const bookId = Number(bookSel.value);
			if (!bookId) {
				s.bookId = null;
				s.bookTitle = "";
				s.writingList = [];
				s.targetId = "";
				if (sel) sel.innerHTML = '<option value="">（先选择目标书）</option>';
				if (hint) hint.textContent = handoffTargetHint(s);
				return;
			}
			if (hint) hint.textContent = "正在读取该书的写作会话…";
			const list = await loadWritingConversations(bookId);
			let bookTitle = "";
			for (const b of books || [])
				if (Number(b.id) === bookId) bookTitle = b.title || "";
			s.bookId = bookId;
			s.bookTitle = bookTitle;
			s.writingList = list;
			// 全局范围不预选会话（:929-930）：目标书与会话都要作者点名
			s.targetId = s.bookScope ? defaultTargetId(list, bookId, d.storage) : "";
			if (sel) {
				sel.innerHTML = list.length
					? writingOptions(list, s.targetId, escapeHtml)
					: '<option value="">（这本书还没有写作会话）</option>';
				if (s.targetId) sel.value = s.targetId;
			}
			if (hint) hint.textContent = handoffTargetHint(s);
		});
	}

	// :1012-1021
	async function showHandoffPreview(handoffId) {
		let view = null;
		try {
			view = await d.api(
				"GET",
				`/api/handoffs/${encodeURIComponent(handoffId)}`,
			);
		} catch (e) {
			// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1017 错误文案取值
			toast(`交接预览加载失败：${e && e.message ? e.message : e}`);
			return;
		}
		renderHandoffPreview(view, "preview");
	}

	// :1054-1107（stage='done'＝:1056-1068；预览态＝:1070-1097＋三按钮命令式绑定）
	function renderHandoffPreview(view, stage) {
		if (stage === "done") {
			openModal({
				title: "已交接（一条注明来源的消息）",
				okText: "完成",
				bodyHTML: handoffDoneBodyHTML(view, escapeHtml),
				onOk: () => true,
			});
			return;
		}
		const { html } = handoffPreviewBodyHTML(view, escapeHtml);
		openModal({
			title: "交接预览（接受前请核对材料与来源）",
			okText: "关闭（不交接）",
			bodyHTML: html,
			onOk: () => true, // 关闭不产生写入
		});
		const body = modalBody();
		if (!body) return;
		const acceptBtn = pickIn(body, "#btn-handoff-accept");
		if (acceptBtn) {
			acceptBtn.addEventListener("click", () => acceptHandoff(view, acceptBtn));
		}
		const refreshBtn = pickIn(body, "#btn-handoff-refresh");
		if (refreshBtn)
			refreshBtn.addEventListener("click", () => showHandoffPreview(view.id));
		const cancelBtn = pickIn(body, "#btn-handoff-cancel");
		if (cancelBtn) {
			cancelBtn.addEventListener("click", () => cancelHandoff(view, cancelBtn));
		}
	}

	// :1110-1144
	async function cancelHandoff(view, btn) {
		if (cancellingRef.current || acceptingRef.current) return;
		// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1112 守卫形态
		if (!view || !view.id) return;
		if (view.status === "accepted") {
			toast(
				"这条交接已经写进写作会话：作废不会撤回那条消息。要换结论请重新创建草案。",
			);
			return;
		}
		const confirmFn =
			typeof d.confirm === "function"
				? d.confirm
				: typeof globalThis === "undefined"
					? null
					: globalThis.confirm;
		const ok =
			typeof confirmFn === "function" &&
			confirmFn(
				"作废这份交接草案？\n\n" +
					"只作废草案本身（未向写作会话写入任何内容）；\n" +
					"已经采纳过、写进写作会话的消息不会因此撤回。",
			);
		if (!ok) return;
		cancellingRef.current = true;
		if (btn) {
			btn.disabled = true;
			btn.textContent = "作废中…";
		}
		try {
			const result = await d.api(
				"POST",
				`/api/handoffs/${encodeURIComponent(view.id)}/cancel`,
				{},
			);
			closeModal();
			toast(
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1125 duplicate 分支
				result && result.duplicate
					? "该草案此前已作废（未向写作会话写入任何内容）"
					: "草案已作废（未向写作会话写入任何内容）",
			);
		} catch (e) {
			// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1129 错误码取值
			const code = e && e.code ? e.code : "";
			if (code === "HANDOFF_ALREADY_ACCEPTED") {
				toast(
					"这条交接已经写进写作会话：作废不会撤回那条消息（要换结论请重新创建草案）",
				);
			} else if (code === "HANDOFF_ALREADY_SETTLED") {
				toast("该交接刚刚已被处理：请刷新预览确认当前状态");
			} else {
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1135 兜底文案
				toast(`作废失败：${e && e.message ? e.message : e}`);
			}
			if (btn) {
				btn.disabled = false;
				btn.textContent = "作废草案";
			}
			if (
				code === "HANDOFF_ALREADY_ACCEPTED" ||
				code === "HANDOFF_ALREADY_SETTLED"
			) {
				await showHandoffPreview(view.id); // 让「已处理」立刻可见（:1139）
			}
		} finally {
			cancellingRef.current = false;
		}
	}

	// :1147-1184（唯一写入点；服务端幂等）
	async function acceptHandoff(view, btn) {
		if (acceptingRef.current) return;
		// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1149 守卫形态
		if (view && view.target && view.target.busy) {
			toast(
				"目标会话正在运行中：等这一轮结束后点「重新预览」再交接（不会混进正在发给模型的请求）",
			);
			return;
		}
		// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1153 守卫形态
		if (!view || !view.sourceFingerprint || view.sourceChanged) {
			toast("来源已变更：请重新预览后再交接");
			return;
		}
		acceptingRef.current = true;
		if (btn) {
			btn.disabled = true;
			btn.textContent = "交接中…";
		}
		try {
			const result = await d.api(
				"POST",
				`/api/handoffs/${encodeURIComponent(view.id)}/accept`,
				{ expectedSourceFingerprint: view.sourceFingerprint },
			);
			renderHandoffPreview(result, "done");
			toast(
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1163 duplicate 分支
				result && result.duplicate
					? "该交接此前已交接（同一条消息，未重复插入）"
					: "已交接到写作会话（一条注明来源的消息）",
			);
		} catch (e) {
			// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1167 错误码取值
			const code = e && e.code ? e.code : "";
			if (code === "HANDOFF_TARGET_BUSY") {
				toast("目标会话正在运行中：等这一轮结束后点「重新预览」再接受");
			} else if (code === "HANDOFF_SOURCE_CHANGED") {
				toast("来源资料已更新：请点「重新预览」核对后再接受");
			} else if (code === "HANDOFF_TARGET_ARCHIVED") {
				toast("目标写作会话已归档：请在写作页另开会话后重新创建交接");
			} else {
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1175 兜底文案
				toast(`交接失败：${e && e.message ? e.message : e}`);
			}
			if (btn) {
				btn.disabled = false;
				btn.textContent = "接受交接（写入写作会话）";
			}
			if (code === "HANDOFF_TARGET_BUSY" || code === "HANDOFF_SOURCE_CHANGED") {
				await showHandoffPreview(view.id); // 让「忙碌/过期」立刻可见（:1179）
			}
		} finally {
			acceptingRef.current = false;
		}
	}

	// :967-1010（origin 会话由调用方传入＝legacy 模块态 currentConversation 的参数化）
	async function submitHandoffDraft(body, s, conversation) {
		const targetSel = pickIn(body, "#handoff-target-conversation");
		const textEl = pickIn(body, "#handoff-text");
		const targetConversationId = targetSel ? String(targetSel.value || "") : "";
		const text = textEl ? String(textEl.value || "") : "";
		if (!targetConversationId) {
			toast(
				s.bookScope
					? "请选择目标写作会话（交接只写入你选定的会话）"
					: "请先选定目标书与写作会话（全局讨论不自动挑书）",
			);
			return false;
		}
		// 来源引用勾选框与渲染条件一致：只有该引用存在时才查它（:978-987）
		const refs = [];
		if (s.chapterId) {
			const chapterBox = pickIn(body, "#handoff-ref-chapter");
			if (!chapterBox || chapterBox.checked)
				refs.push({ kind: "chapter", id: s.chapterId });
		}
		if (s.note) {
			const noteBox = pickIn(body, "#handoff-ref-note");
			if (!noteBox || noteBox.checked)
				refs.push({ kind: "planning_note", id: s.note.id });
		}
		if (!String(text).trim() && !s.picks.length) {
			toast("交接材料不能为空：写一句摘要或先勾选讨论结论");
			return false;
		}
		if (submittingRef.current) return false; // 防重复点击：一次点击只创建一个草案（:992）
		submittingRef.current = true;
		try {
			const draft = await d.api("POST", "/api/handoffs", {
				originConversationId: conversation.id,
				targetConversationId: targetConversationId,
				selectedMessageIds: s.picks.map((m) => m.id),
				text: String(text).trim(),
				sourceRefs: refs,
			});
			await showHandoffPreview(draft.id);
			return false; // 保持在弹窗上：下一步是预览与接受（:1003）
		} catch (e) {
			// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1005 兜底文案
			toast(`创建交接草案失败：${e && e.message ? e.message : e}`);
			return false;
		} finally {
			submittingRef.current = false;
		}
	}

	// :941-965
	async function createHandoff(ctx) {
		const {
			conversation,
			scope,
			books,
			boundaryChapters,
			boundaryChapterId,
			picks,
		} = ctx || {};
		if (!conversation) {
			toast("请先选择会话");
			return;
		}
		if (conversation.status !== "active") {
			toast("该会话已归档：只读，不能交接");
			return;
		}
		// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :944 勾选前置校验
		if (!picks || !picks.length) {
			toast("先在讨论里勾选要交接的结论");
			return;
		}
		const bookScope = scope.kind === "book";
		const bookId = bookScope ? Number(scope.bookId) : null;
		const writingList = bookId ? await loadWritingConversations(bookId) : [];
		const note = noteRef.current;
		const s = {
			bookScope: bookScope,
			bookId: bookId,
			bookTitle: bookScope ? scopeBookTitle(books, scope) : "",
			writingList: writingList,
			targetId: bookScope
				? defaultTargetId(writingList, bookId, d.storage)
				: "",
			picks: picks.slice(),
			chapterId:
				bookScope && boundaryChapterId ? Number(boundaryChapterId) : null,
			note: note && note.conversationId === conversation.id ? note : null,
		};
		openModal({
			title: "创建交接到写作（草案）",
			okText: "创建草案",
			bodyHTML: handoffComposeBodyHTML(s, {
				books: books,
				boundaryChapters: boundaryChapters,
				escapeHtml: escapeHtml,
			}),
			onOk: (body) => submitHandoffDraft(body, s, conversation),
		});
		bindHandoffCompose(s, books);
	}

	// :767-806
	function saveNote(ctx) {
		const { conversation, scopeTitle, picks } = ctx || {};
		if (!conversation) {
			toast("请先选择会话");
			return;
		}
		if (conversation.status !== "active") {
			toast("该会话已归档：只读，不能再新建笔记");
			return;
		}
		// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :770 勾选前置校验
		if (!picks || !picks.length) {
			toast("先在讨论里勾选要沉淀的结论");
			return;
		}
		const snapshot = picks.slice();
		openModal({
			title: "存为规划笔记（草稿）",
			okText: "存为笔记",
			bodyHTML: noteModalBodyHTML(scopeTitle, snapshot, escapeHtml),
			onOk: async (body) => {
				const titleEl = pickIn(body, "#agent-note-title");
				const textEl = pickIn(body, "#agent-note-text");
				const text = textEl ? String(textEl.value || "").trim() : "";
				if (!text) {
					toast("笔记正文不能为空（服务端不接受空笔记）");
					return false;
				}
				try {
					const note = await d.api("POST", "/api/planning-notes", {
						conversationId: conversation.id,
						title: titleEl ? String(titleEl.value || "").trim() : "",
						text: text,
						selectedMessageIds: snapshot.map((m) => m.id),
					});
					const saved = {
						id: note.id,
						title: note.title || "",
						revision: note.revision,
						conversationId: note.conversationId,
					};
					noteRef.current = saved;
					setLastPlanningNote(saved);
					toast(
						"已存为规划笔记草稿（不是故事事实；创建交接时可把它作为来源引用）",
					);
					return true;
				} catch (e) {
					// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :801 兜底文案
					toast(`存笔记失败：${e && e.message ? e.message : e}`);
					return false;
				}
			},
		});
	}

	return {
		lastPlanningNote: lastPlanningNote,
		saveNote: saveNote,
		createHandoff: createHandoff,
		submitHandoffDraft: submitHandoffDraft,
		showHandoffPreview: showHandoffPreview,
		acceptHandoff: acceptHandoff,
		cancelHandoff: cancelHandoff,
	};
}
