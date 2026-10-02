// S5-1（charter §3 切片清单第 1 行，范式 P 路由页型，S4-2 cards／S4-3 timeline／S4-5 style-lab 先例）：
// ReadPage —— #/book/:id/read 阅读/精修整页等值迁 React（public/legacy/book-read.js 709 行，
// 本片 git rm 全退役）。app.js:179 单行换名 window.MozhenReadPage（路由本体/正则/#page-read 显隐
// 留在 app.js——React Router 移交属 S5-3）；index.html:768 标签删。
//
// 逐字等值要点（行号为 legacy book-read.js 锚点）：
// - JSX 镜像 index.html:676-740 #page-read 静态壳（id/class/文案逐字）。静态 markup 双维护为已知
//   边界（S4-2 CardsPage 先例）：React 整容器接管后在运行时覆盖它，静态 markup 保留供 CSS/巡检/对照。
// - 入口 :634-657（loadPrefs → GET /api/books/:id → loadStructure → 章号选择 → selectChapter → 三态）；
//   目录 :46-97（卷序＋卷内归属＋未归卷/悬空卷兜底组 read-toc-orphan；data-id 形态保留）；
//   正文分段与偏移 :171-188/:488-501；字数 :190-193；导航 :195-205；
//   模式/主题/字号 :207-229（localStorage novel-read:* :33-43/:666-667）；
//   标题就地改名 :120-169（含「精修且正文已改未存先落库」、「失败还原标题且冲突时不动编辑器」）；
//   保存 :232-284（428 唯一防御性重读重试、409 走 ChapterConflict 显式二选一、无桥 toast 兜底）；
//   AI 侧边栏 :286-477（流式/工具块/确认卡/停止/被新提问打断/duplicate 等待运行）；
//   选中段引用与替换 :479-631（含 sanitizeReply 五组净化语义与偏移校验→indexOf 回退）。
//
// §2.5 三处互操作契约（Plan 判定的本片成败点，红测 R10/R13/R14 钉住）：
// 〔1〕#read-ai-messages 由 React **只渲染容器本身**，子节点全部命令式 append/insertBefore
//     （工具块与确认卡经 `chatApi().renderToolEvent/renderActionCard` 直取——P6-2 §2.5-D4 去全局化，
//     原 window.BookPage 旧名面退役；opts 恰 {bookId, onSettled, resume}）——渲染器产物绝不进
//     React children（React 若参与该容器 reconciliation 会在下次渲染时抹掉外来节点）。
// 〔2〕React 树渲染同 id 同 tag 同 class 的 #read-health-btn/#read-samples-btn/#read-editor，
//     挂载后调 mountStyleHealth()（StyleHealthPanel.jsx:412 既有导出）重绑 onclick；章节切换仍按
//     :111 守卫调 `renderStyleHealth(bookId, chapterId)`（P6-2 去全局化：由 StyleHealthPanel.jsx
//     导出直取，原 window.StyleHealth 旧名面退役）；健康按钮显隐/title 由 React 按
//     renderStyleHealth 同规则渲染（双保险，同源同结果）。
// 〔3〕ChatEventHub **直接 import** ../lib/chat-event-hub.js（lib 十六 API 与 legacy :385-402 导出行
//     一一对应），不经 window.ChatEventHub 旧名桥（那是留给 book-chat/agent 两 legacy 消费方的）。
//
// 状态模型：legacy 的模块级 S 单例由组件实例内的 ref 承接（key=visit++ 每次重挂＝旧 show() 每次
// 重置重拉 :634-657）；改状态后 rerender() 触发 React 重渲，等价旧实现直接写 DOM。
// 消息区与 #read-editor.value 仍按 legacy 语义命令式写（ref）——§2.5 契约 1 与控件体量所致。

import { Fragment, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { showConflictDialog } from "../components/ChapterConflictDialog.jsx";
import { chatApi } from "../components/ChatWorkspace.jsx";
import {
	mountStyleHealth,
	renderStyleHealth,
} from "../components/StyleHealthPanel.jsx";
import { getApp } from "../lib/app-runtime.js";
import {
	consumeBookStream,
	createAbort,
	isAbortError,
	isActiveStatus,
	isJsonResponse,
	newRequestId,
	parseResponseError,
	waitRunEvents,
} from "../lib/chat-event-hub.js";

// 消息来源标注（B5，:289 逐字）：侧边栏发的消息在库里标 source='read'。
const SOURCE_LABELS = {
	writing: "写作台",
	read: "阅读页",
	agent: "助手",
	system: "系统",
};

function wordCount(text) {
	return String(text || "").replace(/\s/g, "").length;
}

// 正文分段并记录每段在原始 content 中的 [start,end)（:488-501 逐字）——
// 按换行分段、trim、丢弃空段；start/end 指向 trim 后文本在原文的偏移（D3-02/03 精确回定位基础）。
export function splitParas(content) {
	const out = [];
	const re = /[^\r\n]+/g;
	let m = re.exec(content);
	while (m !== null) {
		const raw = m[0];
		const text = raw.trim();
		if (text) {
			const lead = raw.match(/^\s*/)[0].length;
			const trail = raw.match(/\s*$/)[0].length;
			out.push({
				text: text,
				start: m.index + lead,
				end: m.index + raw.length - trail,
			});
		}
		m = re.exec(content);
	}
	return out;
}

// 计算 DOM 点 (node,offset) 相对其所属 <p> 文本起点的字符偏移（:504-517 逐字）。
function paraOffsetIn(p, node, offset) {
	if (node === p) {
		let sum = 0;
		for (let i = 0; i < offset && i < p.childNodes.length; i++) {
			sum += (p.childNodes[i].textContent || "").length;
		}
		return sum;
	}
	if (node.parentNode === p) return offset; // 扁平 <p> 的直接文本子节点（本渲染即此形态）
	try {
		const r = document.createRange();
		r.selectNodeContents(p);
		r.setEnd(node, offset);
		return r.toString().length;
	} catch (_e) {
		return null;
	}
}

// 把 DOM 点映射回原始正文的绝对偏移；定位失败返回 null（调用方回退 indexOf，:520-531）。
function domPointToContentPos(node, offset, paras) {
	const el = node.nodeType === 1 ? node : node.parentNode;
	const p = el?.closest ? el.closest("p[data-pidx]") : null;
	if (!p) return null;
	const para = paras[Number.parseInt(p.dataset.pidx, 10)];
	if (!para) return null;
	let within = paraOffsetIn(p, node, offset);
	if (within == null) return null;
	if (within < 0) within = 0;
	if (within > para.text.length) within = para.text.length;
	return para.start + within;
}

// 替换前净化 AI 回复（:590-601 逐字）：剥代码围栏、「改写后：」式前导行，只剥同族成对首尾引号
// （跨族不配对不得剥；整段引文对话不得误删）。
export function sanitizeReply(text) {
	const lines = String(text || "")
		.trim()
		.split("\n");
	if (lines.length && lines[0].indexOf("```") === 0) lines.shift();
	if (lines.length && lines[lines.length - 1].trim().indexOf("```") === 0)
		lines.pop();
	let t = lines.join("\n").trim();
	t = t.replace(
		/^(?:#{1,6}[^\n]*|(?:改写后|修改后|润色后|改后|重写后)\s*[:：])\s*(?:\n+|$)/,
		"",
	);
	const qm = t.match(
		/^(?:"([\s\S]*)"|“([\s\S]*)”|「([\s\S]*)」|『([\s\S]*)』)$/,
	);
	if (qm) {
		t =
			qm[1] != null
				? qm[1]
				: qm[2] != null
					? qm[2]
					: qm[3] != null
						? qm[3]
						: qm[4];
	}
	return t.trim();
}

export default function ReadPage({ bookId, chapterId }) {
	const store = useRef(null);
	if (store.current === null) {
		store.current = {
			bookId: bookId,
			initialChapterId: chapterId ?? null,
			bookTitle: "",
			chapterId: null,
			chapter: null,
			volumes: [],
			chapters: [], // 扁平、按卷/序排列
			paras: [], // 阅读视图每段在原始正文中的偏移 {text,start,end}
			mode: "read", // 'read' | 'edit'
			theme: "light",
			fontSize: 18,
			pendingSelection: null, // {start,end,text,rawText?}
			lastReply: "",
			streaming: false,
			sendToken: 0,
			abortCtl: null,
			// 渲染可见态（等价 legacy 直接切 classList 的三处按钮态）
			reviseHidden: true,
			applyReplyHidden: true,
			sendDisabled: false,
			reviseDisabled: false, // ISSUE-2 整改：流式起止对称置位的 disabled（等值 legacy :364/:473）
			stopVisible: false,
			titleEditing: false,
			titleDraft: "",
			wordText: "共 0 字",
			tocCollapsed: false,
			aiCollapsed: false,
			aiText: "",
		};
	}
	const s = store.current;
	const [, setTick] = useState(0);
	const rerender = () => setTick((n) => n + 1);
	// ISSUE-1 整改：进入标题编辑态后触发一次 focus/select（见 showTitleInput 上方注释）
	const [titleFocusTick, setTitleFocusTick] = useState(0);

	const editorRef = useRef(null);
	const msgWrapRef = useRef(null);
	const titleInputRef = useRef(null);

	const prefKey = (name) => `novel-read:${name}:${s.bookId}`;
	const progressKey = () => `novel-read:progress:${s.bookId}`;
	const basePath = () => `/api/books/${s.bookId}/chapters`;
	const volPath = () => `/api/books/${s.bookId}/volumes`;

	// ---------- 持久化偏好（:33-43 逐字） ----------
	function loadPrefs() {
		try {
			s.theme = localStorage.getItem(prefKey("theme")) || "light";
			const fs = Number.parseInt(localStorage.getItem(prefKey("fontSize")), 10);
			s.fontSize = fs > 0 ? fs : 18;
		} catch (_e) {
			/* ignore */
		}
	}
	function savePref(name, val) {
		try {
			localStorage.setItem(prefKey(name), String(val));
		} catch (_e) {
			/* ignore */
		}
	}

	// ---------- 目录 / 章节（:46-97 逐字） ----------
	async function loadStructure() {
		const volRes = await getApp().api("GET", volPath());
		s.volumes = volRes.volumes || [];
		const res = await getApp().api("GET", basePath());
		const all = res.chapters || [];
		s.chapters = [];
		for (let v = 0; v < s.volumes.length; v++) {
			const vol = s.volumes[v];
			for (let i = 0; i < all.length; i++) {
				if (all[i].volume_id === vol.id) s.chapters.push(all[i]);
			}
		}
		// 未归卷的章节兜底追加
		for (let k = 0; k < all.length; k++) {
			if (s.chapters.indexOf(all[k]) < 0) s.chapters.push(all[k]);
		}
		rerender();
	}

	async function selectChapter(cid) {
		try {
			const res = await getApp().api("GET", `${basePath()}/${cid}`);
			s.chapter = res.chapter;
			s.chapterId = cid;
			s.pendingSelection = null;
			try {
				localStorage.setItem(progressKey(), String(cid));
			} catch (_e) {
				/* ignore */
			}
			renderChapter();
			// 作家仓库 · 体检入口（旁路，:109-111 逐字）：只把当前书/章告知面板模块，
			// 面板自身不参与本页任何状态与渲染——删掉这行与 style-health.js，本页行为不变
			if (renderStyleHealth) renderStyleHealth(s.bookId, s.chapterId);
			rerender();
		} catch (e) {
			getApp().toast(e.message);
		}
	}

	function updateNav() {
		// 导航 disabled 由渲染期派生（等价 :195-199）：idx 越界即两侧皆禁
		rerender();
	}

	function stepChapter(delta) {
		const idx = s.chapters.findIndex((c) => c.id === s.chapterId);
		const next = s.chapters[idx + delta];
		if (next) selectChapter(next.id);
	}

	function renderChapter() {
		const ch = s.chapter || {};
		s.titleEditing = false;
		// 阅读视图：按段渲染，并记录每段在原始正文中的偏移（D3-02/03 精确回定位所需）
		const content = ch.content || "";
		s.paras = splitParas(content);
		if (editorRef.current) editorRef.current.value = content;
		updateWordCount();
		rerender();
	}

	function updateWordCount() {
		const text =
			s.mode === "edit"
				? editorRef.current?.value || ""
				: s.chapter?.content || "";
		s.wordText = `共 ${wordCount(text)} 字`;
		rerender();
	}

	// ---------- 模式 / 主题 / 字号（:207-229 逐字） ----------
	function applyMode() {
		if (s.mode !== "edit") {
			// 阅读模式收起两个选区按钮（:215 逐字）；select/取消选区时会再次按需放开
			s.reviseHidden = true;
			s.applyReplyHidden = true;
		}
		updateWordCount();
		rerender();
	}
	function setMode(m) {
		s.mode = m;
		applyMode();
	}

	// ---------- 标题改名（:120-169 逐字） ----------
	// ISSUE-1（S5-1-review-1 整改）：focus/select 不能与状态更新同拍调用——React 的提交是异步的，
	// 此刻 input 仍带 hidden（显示 none），真实浏览器下 focus() 静默失效（旧实现直接操作已是可见
	// 的 DOM，故 :127-129 的同步两行天然成立）。改由 effect 承接：进入编辑态后自增 titleFocusTick，
	// 提交完成（input 已亮出）再 focus＋select 全选，仍等值 legacy 的「点标题即可直接输入替换」。
	// biome-ignore lint/correctness/useExhaustiveDependencies: titleFocusTick 自增即「刚进入编辑态」这一次触发，s 为 ref 读取
	useEffect(() => {
		if (!titleFocusTick) return;
		const el = titleInputRef.current;
		if (!el || !s.titleEditing) return;
		el.focus();
		el.select();
	}, [titleFocusTick]);

	function showTitleInput() {
		if (!s.chapterId) return;
		if (s.titleEditing) return;
		s.titleDraft = s.chapter?.title || "";
		s.titleEditing = true;
		setTitleFocusTick((n) => n + 1);
		rerender();
	}

	function hideTitleInput() {
		if (!s.titleEditing) return;
		s.titleEditing = false;
		rerender();
	}

	async function commitTitle() {
		if (!s.titleEditing || !s.chapterId) return;
		const title = String(s.titleDraft || "").trim();
		const previous = s.chapter?.title || "";
		hideTitleInput();
		if (!title || title === previous) return;
		try {
			// 精修模式下正文可能已改未存：先存正文，避免改名后 renderChapter 用旧正文回填编辑器丢手改（:147-150）
			if (
				s.mode === "edit" &&
				editorRef.current?.value !== (s.chapter?.content || "")
			) {
				await save();
			}
			const putBody = { title: title };
			// S1-03：改名也走版本比对；上面的先落库（save 成功时）已刷新 S.chapter.revision（:151-153）
			if (s.chapter && s.chapter.revision != null) {
				putBody.expected_revision = Number(s.chapter.revision);
			}
			const res = await getApp().api(
				"PUT",
				`${basePath()}/${s.chapterId}`,
				putBody,
			);
			s.chapter = res.chapter || s.chapter;
			s.chapter.title = title;
			const ch = s.chapters.find((c) => c.id === s.chapterId);
			if (ch) ch.title = title;
			getApp().toast("已重命名");
			rerender();
		} catch (e) {
			getApp().toast(e.message);
			if (s.chapter) s.chapter.title = previous;
			// 冲突时不动编辑器：正文草稿可能因冲突未落库（save 已把本地稿留在编辑器），
			// renderChapter 用旧快照回填会把它抹掉（:165-167）
			if (
				!(
					s.mode === "edit" &&
					e &&
					(e.code === "CHAPTER_CONFLICT" ||
						e.code === "CHAPTER_REVISION_REQUIRED")
				)
			) {
				renderChapter();
			}
			rerender();
		}
	}

	// ---------- 保存（:232-284 逐字） ----------
	async function save() {
		if (!s.chapterId) return;
		try {
			// S1-03/C04-B：携带打开章节时的服务端 revision（单调版本），版本不符=别处已改，
			// 走 ChapterConflict 显式二选一，不静默覆盖也不自动重载。
			const body = { content: editorRef.current?.value || "" };
			if (s.chapter && s.chapter.revision != null) {
				body.expected_revision = Number(s.chapter.revision);
			}
			let res;
			try {
				res = await getApp().api("PUT", `${basePath()}/${s.chapterId}`, body);
			} catch (e1) {
				// 快照缺版本（428）：按服务端契约「先读当前 revision 再写」重读一次后重试；
				// 仅此一个防御性重试，重试后 409 仍走冲突对话（:242-253）。
				if (
					e1 &&
					e1.code === "CHAPTER_REVISION_REQUIRED" &&
					!(s.chapter && s.chapter.revision != null)
				) {
					const reread = await getApp().api(
						"GET",
						`${basePath()}/${s.chapterId}`,
					);
					s.chapter = reread.chapter;
					body.expected_revision = Number(s.chapter.revision);
					res = await getApp().api("PUT", `${basePath()}/${s.chapterId}`, body);
				} else {
					throw e1;
				}
			}
			if (res?.autoUnlocked) {
				getApp().toast("该章原定稿，修改后已自动解除定稿");
			} else {
				getApp().toast("已保存");
			}
			s.chapter = res.chapter || s.chapter;
			s.chapter.content = editorRef.current?.value || "";
			updateWordCount();
		} catch (e) {
			// 409 冲突：另一窗口/AI 已修改本章。拉最新版弹显式二选一——本地稿留在编辑器，
			// 复制/比对/重载由作者决定（:259-281 逐字）。
			if (
				e &&
				(e.code === "CHAPTER_CONFLICT" ||
					e.code === "CHAPTER_REVISION_REQUIRED" ||
					/已被修改/.test(e.message || ""))
			) {
				try {
					const fresh = await getApp().api(
						"GET",
						`${basePath()}/${s.chapterId}`,
					);
					if (showConflictDialog) {
						showConflictDialog({
							server: fresh.chapter,
							local: { content: editorRef.current?.value || "" },
							onReload(srv) {
								if (s.chapterId !== srv.id) return; // 弹窗期间已切章：不动编辑器
								s.chapter = srv;
								renderChapter();
							},
						});
					} else {
						getApp().toast(
							"章节已在其他窗口被修改，本地稿已保留在编辑器中，请核对后重试",
						);
					}
				} catch (_) {
					getApp().toast("获取服务端最新版本失败，本地稿已保留，可先手动复制");
				}
				return;
			}
			getApp().toast(e.message);
		}
	}

	// ---------- AI 侧边栏（:286-477 逐字） ----------
	function makeSourceTag(source) {
		const label = SOURCE_LABELS[source] || "";
		if (!label) return null;
		const tag = document.createElement("span");
		tag.className = `msg-source msg-source-${source}`;
		tag.textContent = label;
		return tag;
	}

	function appendMsg(role, text, source) {
		const wrap = msgWrapRef.current;
		if (!wrap) return null;
		const div = document.createElement("div");
		div.className = `msg ${role}`;
		// 仅当有来源时才多出一行标注（无来源保持改造前 DOM，历史/未知来源静默兼容）
		const tag = makeSourceTag(source);
		if (tag) {
			const srcRow = document.createElement("div");
			srcRow.className = "msg-role";
			srcRow.textContent = role === "user" ? "我" : "写作助手";
			srcRow.appendChild(tag);
			div.appendChild(srcRow);
		}
		const bubble = document.createElement("div");
		bubble.className = "msg-bubble";
		bubble.textContent = text || "";
		div.appendChild(bubble);
		wrap.appendChild(div);
		wrap.scrollTop = wrap.scrollHeight;
		return bubble;
	}

	function updateStopBtn() {
		s.stopVisible = !!s.abortCtl;
		rerender();
	}

	function sendToAI(content, targetSel) {
		// B5：阅读页发出的消息标 source='read'，写作台/助手页据此显示「阅读页」来源标签
		return streamChat(
			{ content: content, chapterId: s.chapterId, source: "read" },
			targetSel,
			content,
		);
	}

	// 确认卡结算后续跑（:333-337 逐字）：执行结果作为系统事件回灌，AI 继续原任务
	function readResumeAfterConfirm(actionId) {
		if (!s.bookId) return;
		appendMsg(
			"user",
			"[确认执行结果·系统事件] 已把执行结果交给 AI，继续之前的任务…",
			"read",
		);
		streamChat(
			{ resumeActionId: actionId, chapterId: s.chapterId, source: "read" },
			null,
			null,
		);
	}

	// 写操作落地后的联动刷新（:340-346 逐字）：涉及章节的工具刷新目录；改动的是当前章则重载正文
	async function readRefreshAfterWrite(name, args) {
		if (
			[
				"create_chapter",
				"append_chapter",
				"replace_chapter",
				"set_chapter_meta",
			].indexOf(name) >= 0
		) {
			await loadStructure();
			const cid = args && (args.chapterId || args.chapter?.id);
			if (cid && cid === s.chapterId) await selectChapter(s.chapterId);
		}
	}

	async function streamChat(body, targetSel, userEcho) {
		// 上一次请求若还挂着（服务端长响应/断流）：取消它再发新的（:352-355）
		const my = ++s.sendToken;
		if (s.abortCtl) {
			try {
				s.abortCtl.stop("superseded");
			} catch (_e) {
				/* ignore */
			}
		}
		const runAbort = createAbort();
		s.abortCtl = runAbort;
		s.streaming = true;
		if (userEcho) appendMsg("user", userEcho, "read");
		const bubble = appendMsg("assistant", "", "read");
		if (bubble) bubble.textContent = "（AI 思考中…）";
		let started = false;
		s.sendDisabled = true;
		s.reviseDisabled = true; // ISSUE-2 整改：等值 :364 `$('read-ai-revise').disabled = true`
		updateStopBtn();
		try {
			// S2-01：幂等 requestId——网络重试/双击复用同一个，服务端返回既有运行不重跑
			if (!body.request_id) body.request_id = newRequestId("read");
			// S3-03：阅读页默认继续作者选定的写作会话（与写作台共享同一存储 key，:369-372）
			if (!body.conversationId) {
				try {
					body.conversationId =
						localStorage.getItem(`writing_conversation_${s.bookId}`) ||
						undefined;
				} catch (_e) {
					/* 忽略 */
				}
			}
			const res = await fetch(`/api/books/${s.bookId}/chat/stream`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal: runAbort.signal,
			});
			if (res.status === 409) {
				// 阅读页没有排队语义（那是写作台的单飞闸门职责），CHAT_BUSY 与其他 409 一样直接提示（:379-382）
				throw await parseResponseError(res, "流式请求失败");
			}
			// S2-01：重复请求（同 requestId）返回 JSON 而非 SSE——不解析成流、不重发业务请求（:383-401）
			if (isJsonResponse(res)) {
				let dupR = null;
				try {
					dupR = await res.json();
				} catch (_e) {
					/* ignore */
				}
				if (dupR?.duplicate) {
					if (bubble) {
						bubble.textContent = "（该请求已在另一窗口进行，等待其结果…）";
					}
					if (isActiveStatus(dupR.status)) {
						try {
							await waitRunEvents({
								runId: dupR.runId,
								sessionKey: dupR.sessionKey,
								signal: runAbort.signal,
							});
						} catch (e2) {
							if (!isAbortError(e2)) {
								getApp().toast(`等待运行结果失败：${e2.message}`);
							}
						}
					}
					if (bubble) {
						bubble.textContent = "（该请求已在另一窗口完成，结果见写作台会话）";
					}
					return;
				}
				throw await parseResponseError(res, `请求失败 ${res.status}`);
			}
			if (!res.ok || !res.body) throw new Error("流式请求失败");
			const wrap = msgWrapRef.current;
			const state = await consumeBookStream(res, {
				onDelta(t) {
					if (!started) {
						started = true;
						if (bubble) bubble.textContent = "";
					}
					if (bubble) bubble.textContent += t;
					if (wrap) wrap.scrollTop = wrap.scrollHeight;
				},
				onTool(t) {
					// P6-2 §2.5-D4：渲染器经 chatApi() 直取（未挂载面 NULL 占位亦恒产出节点 ⇒
					// 旧 `if (!window.BookPage?.renderToolEvent) return` 真值守卫移除＝不可达差异备案）
					const tb = chatApi().renderToolEvent(t);
					bubble.parentNode.insertBefore(tb, bubble);
					if (wrap) wrap.scrollTop = wrap.scrollHeight;
				},
				onAction(a) {
					// P6-2 §2.5-D4：同上（不可达差异备案）
					const ac = chatApi().renderActionCard(a, {
						bookId: s.bookId,
						onSettled: readRefreshAfterWrite,
						resume: readResumeAfterConfirm,
					});
					bubble.parentNode.insertBefore(ac, bubble);
					if (wrap) wrap.scrollTop = wrap.scrollHeight;
				},
				onRecovering() {
					getApp().toast("输出被截断或连接中断，正在无缝续写…");
				},
				onError(info) {
					getApp().toast(info.message || "AI 返回错误");
				},
				onDone(ev, st) {
					if (st?.aborted) return; // 用户停止：部分输出不作为可替换回复
					// 只有真正拿到过正文，才记录回复/开放替换按钮（:430-435）
					if (ev && typeof ev.content === "string" && ev.content) {
						started = true;
						s.lastReply = ev.content;
						if (bubble) bubble.textContent = s.lastReply;
					} else if (started) {
						s.lastReply = bubble.textContent;
					}
					// D3-05：把回复绑定到「触发它的那段选区」（:439-441）
					if (targetSel && started) targetSel.reply = s.lastReply;
					if (started && targetSel && s.pendingSelection === targetSel) {
						s.applyReplyHidden = false;
						rerender();
					}
				},
			});
			if (state.aborted) {
				if (runAbort.reason() === "user") {
					if (bubble) {
						bubble.textContent = started
							? `${bubble.textContent}\n（已停止生成）`
							: "（已停止生成）";
					}
				} else if (bubble) {
					bubble.textContent = "（本次请求已被新的提问取消）";
				}
			} else {
				const finalText =
					typeof state.finalContent === "string"
						? state.finalContent
						: state.content;
				if (!started && !finalText) {
					if (bubble) {
						bubble.textContent =
							"（AI 未返回内容：可能超时或断流，可重发一次）";
					}
				} else {
					if (finalText) s.lastReply = finalText;
					else if (!s.lastReply) s.lastReply = bubble ? bubble.textContent : "";
					if (targetSel) targetSel.reply = s.lastReply; // D3-05：兜底绑定（done 事件缺失时）
					if (targetSel && s.pendingSelection === targetSel) {
						s.applyReplyHidden = false;
						rerender();
					}
				}
			}
		} catch (e) {
			if (isAbortError(e)) {
				if (bubble) {
					bubble.textContent =
						runAbort.reason() === "user"
							? "（已停止生成）"
							: "（本次请求已被新的提问取消）";
				}
			} else {
				getApp().toast(e.message);
			}
		} finally {
			if (my === s.sendToken) {
				s.streaming = false;
				s.abortCtl = null;
				s.sendDisabled = false;
				s.reviseDisabled = false; // ISSUE-2 整改：等值 :473 `$('read-ai-revise').disabled = false`
				updateStopBtn();
			}
		}
	}

	// ---------- 选中段引用（:479-586 逐字） ----------
	function currentSelection() {
		const el = editorRef.current;
		if (!el) return null;
		const st = el.selectionStart;
		const en = el.selectionEnd;
		if (st >= en) return null;
		return { start: st, end: en, text: el.value.slice(st, en) };
	}

	function readSelection() {
		const selObj = window.getSelection();
		if (!selObj || selObj.rangeCount === 0 || selObj.isCollapsed) return null;
		const text = String(selObj.toString()).trim();
		if (!text) return null;
		const out = { text: text, fromRead: true };
		try {
			const range = selObj.getRangeAt(0);
			const a = domPointToContentPos(
				range.startContainer,
				range.startOffset,
				s.paras,
			);
			const b = domPointToContentPos(
				range.endContainer,
				range.endOffset,
				s.paras,
			);
			if (a != null && b != null && a !== b) {
				out.start = Math.min(a, b);
				out.end = Math.max(a, b);
				out.rawText = (s.chapter?.content || "").slice(out.start, out.end);
			}
		} catch (_e) {
			/* 解析失败则只带 text，替换时回退 indexOf 老路 */
		}
		return out;
	}

	function setQuote(sel) {
		s.pendingSelection = sel;
		s.applyReplyHidden = true; // 选区换了，上一轮的替换按钮作废（:560-561）
		rerender();
	}

	function clearQuote() {
		s.pendingSelection = null;
		s.applyReplyHidden = true;
		rerender();
	}

	function withSelectionPrompt(cmd) {
		if (!s.pendingSelection) return cmd;
		return `下面是我从正文中选中的段落（唯一处理对象）：\n"""\n${s.pendingSelection.text}\n"""\n\n我的要求：${cmd}\n\n若要求是改写/润色：只直接输出改后的段落正文，不要解释、不要加引号或标记；若要求是分析或讨论：正常回答。`;
	}

	function checkSelection() {
		const sel = s.mode === "edit" ? currentSelection() : readSelection();
		s.reviseHidden = !sel;
		if (sel) setQuote(sel);
		else clearQuote();
		rerender();
	}

	function reviseSelection() {
		const sel = s.mode === "edit" ? currentSelection() : readSelection();
		if (!sel) return;
		setQuote(sel);
		s.aiCollapsed = false;
		sendToAI(
			withSelectionPrompt(
				"精修改写这一段：保持人称、剧情与设定不变；改写长度与原文相近（上下不超过三成），不要扩写、不要拆成多段、不要新增情节。",
			),
			sel,
		);
	}

	async function applyReplyToSelection() {
		const sel = s.pendingSelection;
		if (!sel) return;
		// D3-05：只用「为这段选区生成的」回复（:606-608）
		const reply = sel.reply;
		if (!reply) {
			getApp().toast("这段的 AI 回复还没生成完，请等它结束再替换");
			return;
		}
		const el = editorRef.current;
		if (!el) return;
		const revised = sanitizeReply(reply);
		if (!revised) {
			getApp().toast("AI 回复里没有可替换的正文");
			return;
		}
		let start;
		let end;
		// 两种模式同一校验：精确偏移只在「选中后正文没再变动」时使用（快照文本仍吻合），
		// 否则回退 indexOf 重定位（:612-622）。
		if (
			typeof sel.start === "number" &&
			typeof sel.end === "number" &&
			el.value.slice(sel.start, sel.end) ===
				(sel.rawText != null ? sel.rawText : sel.text)
		) {
			start = sel.start;
			end = sel.end;
		} else {
			const idx = el.value.indexOf(sel.text); // 回退：正文已变动或拿不到精确偏移
			if (idx < 0) {
				getApp().toast(
					"在当前章正文中找不到这段原文，无法替换（正文可能已被改动）",
				);
				return;
			}
			start = idx;
			end = idx + sel.text.length;
		}
		el.value = el.value.slice(0, start) + revised + el.value.slice(end);
		s.reviseHidden = true;
		clearQuote();
		updateWordCount();
		await save();
		renderChapter();
		getApp().toast("已替换选中段并保存");
	}

	// ---------- 入口（:634-657 逐字；旧 show() 每次进入重置重拉＝key=visit++ 重挂） ----------
	// biome-ignore lint/correctness/useExhaustiveDependencies: key=visit++ 重挂即重拉，等价旧 show() 每次重置（:634-657）
	useEffect(() => {
		loadPrefs();
		rerender();
		// 〔2〕挂载后重绑静态按钮 onclick（StyleHealthPanel.jsx:412 等值 style-health.js init :255-260）：
		// React 接管后按钮节点是新渲染的，旧绑定随静态壳一起消失，须按新节点重绑。
		mountStyleHealth();
		(async () => {
			try {
				const book = await getApp().api("GET", `/api/books/${s.bookId}`);
				s.bookTitle = book.book?.title || "";
			} catch (_e) {
				s.bookTitle = "";
			}
			await loadStructure();
			let cid = s.initialChapterId;
			if (!cid) {
				try {
					cid =
						Number.parseInt(localStorage.getItem(progressKey()), 10) || null;
				} catch (_e) {
					cid = null;
				}
			}
			if (!cid && s.chapters.length) cid = s.chapters[0].id;
			if (cid) await selectChapter(cid);
			else {
				s.chapter = null;
				s.chapterId = null;
				renderChapter();
				updateNav();
			}
			// 末尾 applyTheme/applyFontSize/applyMode（:654-656）：React 由渲染承接，末帧再对齐一次
			rerender();
		})();
	}, []);

	const idx = s.chapters.findIndex((c) => c.id === s.chapterId);
	const isEdit = s.mode === "edit";
	const volumeIds = {};
	for (const v of s.volumes) volumeIds[v.id] = true;
	// 未归卷/悬空卷章节（:80-91 逐字）：volume_id 为空或指向已不存在的卷
	const orphans = s.chapters.filter(
		(c) => !c.volume_id || !volumeIds[c.volume_id],
	);
	const tocItem = (c) => (
		// 等值旧 renderTOC :93-96 的纯鼠标 li onclick（data-id 形态保留）——键盘可达性属行为新增，
		// 「不新增用户可见行为」红线（charter §2 P4 判例）要求原样，故不加键盘语义。
		// biome-ignore lint/a11y/useKeyWithClickEvents: 等值 legacy :93-96 纯鼠标 li onclick
		<li
			key={c.id}
			className={`read-toc-item${c.id === s.chapterId ? " active" : ""}`}
			data-id={c.id}
			onClick={() => selectChapter(c.id)}
		>
			{c.title}
		</li>
	);
	const titleText = s.chapter?.title || "";

	return (
		<>
			<header className="topbar read-topbar">
				<div className="topbar-left">
					<a
						id="read-return"
						href={`#/book/${s.bookId}`}
						className="btn btn-ghost"
					>
						← 返回写作页
					</a>
					<h1 id="read-book-title" className="book-title">
						{s.bookTitle}
					</h1>
				</div>
				<nav className="topbar-actions">
					<span className="read-mode-switch">
						<button
							id="read-mode-read"
							className={`btn btn-small${isEdit ? "" : " mode-on"}`}
							type="button"
							onClick={() => setMode("read")}
						>
							阅读
						</button>
						<button
							id="read-mode-edit"
							className={`btn btn-small${isEdit ? " mode-on" : ""}`}
							type="button"
							onClick={() => setMode("edit")}
						>
							精修
						</button>
					</span>
					<select
						id="read-theme"
						className="read-select"
						title="阅读主题"
						value={s.theme}
						onChange={(e) => {
							s.theme = e.target.value;
							savePref("theme", s.theme);
							rerender();
						}}
					>
						<option value="light">浅色</option>
						<option value="sepia">护眼</option>
						<option value="night">夜间</option>
					</select>
					<button
						id="read-font-minus"
						className="btn btn-ghost btn-small"
						type="button"
						title="缩小字号"
						onClick={() => {
							s.fontSize = Math.max(14, s.fontSize - 1);
							savePref("fontSize", s.fontSize);
							rerender();
						}}
					>
						A-
					</button>
					<button
						id="read-font-plus"
						className="btn btn-ghost btn-small"
						type="button"
						title="放大字号"
						onClick={() => {
							s.fontSize = Math.min(28, s.fontSize + 1);
							savePref("fontSize", s.fontSize);
							rerender();
						}}
					>
						A+
					</button>
					<button
						id="read-samples-btn"
						className="btn btn-ghost btn-small"
						type="button"
						title="看本章检出过的 AI 味标本，并复核"
					>
						错题库
					</button>
					<button
						id="read-health-btn"
						className={`btn btn-ghost btn-small${s.chapterId ? "" : " hidden"}`}
						type="button"
						title={
							s.chapterId
								? "用朱雀检测本章 AI 味（结果只作参考，不设达标线）"
								: ""
						}
					>
						AI 味体检
					</button>
					<button
						id="read-toggle-toc"
						className="btn btn-ghost btn-small"
						type="button"
						onClick={() => {
							s.tocCollapsed = !s.tocCollapsed;
							rerender();
						}}
					>
						目录
					</button>
					<button
						id="read-toggle-ai"
						className="btn btn-ghost btn-small"
						type="button"
						onClick={() => {
							s.aiCollapsed = !s.aiCollapsed;
							rerender();
						}}
					>
						AI
					</button>
				</nav>
			</header>
			<main className="read-main">
				<aside
					id="read-toc"
					className={`read-toc${s.tocCollapsed ? " collapsed" : ""}`}
				>
					<div className="pane-head">
						<span className="pane-title">目录</span>
					</div>
					<ul id="read-toc-list" className="item-list">
						{s.volumes.map((v) => (
							<Fragment key={v.id}>
								<li className="read-toc-vol">{v.title}</li>
								{s.chapters
									.filter((c) => c.volume_id === v.id)
									.map((c) => tocItem(c))}
							</Fragment>
						))}
						{orphans.length ? (
							<>
								<li className="read-toc-vol read-toc-orphan">未归卷</li>
								{orphans.map((c) => tocItem(c))}
							</>
						) : null}
					</ul>
				</aside>
				<section id="read-center" className={`read-center theme-${s.theme}`}>
					<div className="read-chapter-head">
						<button
							id="read-prev"
							className="btn btn-ghost btn-small"
							type="button"
							disabled={idx <= 0}
							onClick={() => stepChapter(-1)}
						>
							← 上一章
						</button>
						{/* 同 id 同 tag 同 class 等值 index.html:708 静态壳（legacy :672-675 亦为 span＋onclick/onkeydown）；
						    public/style.css:1894 的选择器是 .read-chapter-title[role="button"]，换 <button> 即改壳与样式命中面 */}
						{/* biome-ignore lint/a11y/useSemanticElements: 等值静态壳 span role=button（:708/:672-675） */}
						<span
							id="read-chapter-title"
							className={`read-chapter-title${s.titleEditing ? " hidden" : ""}`}
							role="button"
							tabIndex={0}
							title="点击重命名本章（只改标题，不影响正文与定稿状态）"
							onClick={showTitleInput}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									showTitleInput();
								}
							}}
						>
							{titleText}
						</span>
						<input
							id="read-chapter-title-input"
							className={`read-chapter-title-input${s.titleEditing ? "" : " hidden"}`}
							type="text"
							maxLength={120}
							placeholder="章节标题"
							autoComplete="off"
							ref={titleInputRef}
							value={s.titleDraft}
							onChange={(e) => {
								s.titleDraft = e.target.value;
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									commitTitle();
								} else if (e.key === "Escape") {
									e.preventDefault();
									hideTitleInput();
								}
							}}
							onBlur={commitTitle}
						/>
						<button
							id="read-next"
							className="btn btn-ghost btn-small"
							type="button"
							disabled={idx < 0 || idx >= s.chapters.length - 1}
							onClick={() => stepChapter(1)}
						>
							下一章 →
						</button>
					</div>
					<div id="read-article-wrap" className="read-article-wrap">
						<article
							id="read-article"
							className={`read-article${isEdit ? " hidden" : ""}`}
							style={{ fontSize: `${s.fontSize}px` }}
							onMouseUp={checkSelection}
						>
							{s.paras.length ? (
								s.paras.map((p, i) => (
									<p key={p.start} data-pidx={i}>
										{p.text}
									</p>
								))
							) : (
								<p className="read-empty">（本章还没有内容）</p>
							)}
						</article>
						<textarea
							id="read-editor"
							className={`read-editor${isEdit ? "" : " hidden"}`}
							style={{ fontSize: `${Math.max(14, s.fontSize - 2)}px` }}
							placeholder="在这里逐句精修本章…"
							ref={editorRef}
							onInput={updateWordCount}
							onMouseUp={checkSelection}
							onKeyUp={checkSelection}
						/>
					</div>
					<div className="read-foot">
						<button
							id="read-save"
							className={`btn btn-small${isEdit ? "" : " hidden"}`}
							type="button"
							onClick={save}
						>
							保存
						</button>
						<button
							id="read-ai-revise"
							className={`btn btn-small btn-outline${s.reviseHidden ? " hidden" : ""}`}
							type="button"
							disabled={s.reviseDisabled}
							onClick={reviseSelection}
						>
							让AI修改选中段
						</button>
						<button
							id="read-apply-reply"
							className={`btn btn-small btn-outline${s.applyReplyHidden ? " hidden" : ""}`}
							type="button"
							onClick={applyReplyToSelection}
						>
							用AI回复替换选中
						</button>
						<span id="read-word-count" className="word-count">
							{s.wordText}
						</span>
					</div>
				</section>
				<aside
					id="read-ai"
					className={`read-ai${s.aiCollapsed ? " collapsed" : ""}`}
				>
					<div className="chat-head">
						<span className="pane-title">AI 侧边栏</span>
						<span className="pane-head-btns">
							<button
								id="read-ai-clear"
								className="btn btn-ghost btn-small"
								type="button"
								onClick={() => {
									msgWrapRef.current?.replaceChildren();
								}}
							>
								清空
							</button>
						</span>
					</div>
					{/* 〔1〕命令式槽位：React 只渲染本容器，子节点全部命令式 append/insertBefore */}
					<div
						id="read-ai-messages"
						className="chat-messages"
						ref={msgWrapRef}
					/>
					<div
						id="read-ai-quote"
						className={`read-ai-quote${s.pendingSelection ? "" : " hidden"}`}
					>
						{/* ISSUE-4 整改：title 同步引用全文（等值 legacy :556-558 `t.title = sel.text`）——
						    public/style.css:1984-1990 的 -webkit-line-clamp:3 会截断长引用，title 是唯一看全途径 */}
						<span
							id="read-ai-quote-text"
							className="read-ai-quote-text"
							title={s.pendingSelection ? s.pendingSelection.text : undefined}
						>
							{s.pendingSelection ? s.pendingSelection.text : ""}
						</span>
						<button
							id="read-ai-quote-clear"
							className="icon-btn"
							type="button"
							title="清除选中段"
							onClick={clearQuote}
						>
							×
						</button>
					</div>
					<form
						id="read-ai-form"
						className="chat-input"
						onSubmit={(e) => {
							e.preventDefault();
							const text = String(s.aiText || "").trim();
							if (!text) return;
							s.aiText = "";
							rerender();
							// 有选中段引用时：用户的命令作用于该段；无引用时：普通全书聊天
							sendToAI(withSelectionPrompt(text), s.pendingSelection);
						}}
					>
						<textarea
							id="read-ai-text"
							rows={2}
							placeholder="选中正文后上方会显示选中段；输入你的要求（改写/更简洁/换语气/分析…）发送；未选中时即全书讨论"
							value={s.aiText}
							onChange={(e) => {
								s.aiText = e.target.value;
							}}
						/>
						<button
							type="button"
							id="read-ai-stop"
							className={`btn btn-small btn-stop${s.stopVisible ? "" : " hidden"}`}
							title="中止当前生成（已生成的部分会保留）"
							onClick={() => {
								if (s.abortCtl) s.abortCtl.stop("user");
							}}
						>
							停止
						</button>
						<button
							type="submit"
							id="read-ai-send"
							className="btn btn-primary"
							disabled={s.sendDisabled}
						>
							发送
						</button>
					</form>
				</aside>
			</main>
		</>
	);
}

// ---------- 挂载（app.js:179 经 window.MozhenReadPage.show(bookId, chapterId) 委托至此） ----------
// 目标 #page-read 整容器（CardsPage:810 同款）；取不到即安全 no-op。root 首次创建后复用
// （缓存 el.__mozhenReadRoot），每次 mount 以 key=visit++ 重挂——等价旧 show() 每次进入重置重拉；
// app.js 只切 #page-read 显隐、从不重写该容器（grep 实证）→ root 跨访问安全复用。
let visit = 0;

export function mount(newBookId, newChapterId) {
	const el = document.getElementById("page-read");
	if (!el) return;
	let root = el.__mozhenReadRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenReadRoot = root;
	}
	root.render(
		<ReadPage key={visit++} bookId={newBookId} chapterId={newChapterId} />,
	);
}
