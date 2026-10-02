// S5-6（Plan §1.1 G1，charter §3 S5-6 第 6 行）：book-chat.js 块二＝**传输层**的 React 侧纯逻辑核心
// ——public/legacy/book-chat.js（2,133 行，零 diff 保留）:1048-1411 的逐字移植：
//   sendChat :1048-1090（空文本/参谋分支/用户消息落盘）／chatBusy+chatQueue+chatAbort :1092-1099／
//   updateStopBtn :1101-1104（React 侧＝sink.busy → composer.streaming）／runChatStream :1106-1110（W9 入队绑定）／
//   enqueueChat :1112-1127（单飞本地队列）／streamChatOnce :1132-1396（书/会话守卫 :1134-1146、
//   实时气泡挂载 :1148-1157、409 CHAT_BUSY 排队重试 :1271-1284、幂等 JSON 分支 :1285-1321、
//   SSE 消费九回调 :1324-1361、收尾映射 :1363-1381、abort 贯穿 :1382-1395）／
//   resumeAfterConfirm :1401-1406。
//
// 范式：A·判定 C（旧名桥＋死锚点零 diff）的文件级判定沿用 S5-5 §2.3——本文件是「块二建设笔」，
// **零生产切换**：不改 public/**（含 index.html:791 标签）、不注册任何 window.*、不挂载；SSE 一律走
// `import * as hub from "./chat-event-hub.js"`（S4-10 判例 B lib，16 导出），**禁止自写分帧、禁止走
// 旧名全局桥（ChatEventHub 的 window 挂载）**（AGENTS.md §4）。切换点唯一＝S5-7「本文件收尾退役」。
//
// 依赖注入面（Plan §4 通用 harness 纪律＋Plan §5③）：本模块**零 DOM、零全局写入、零硬编码 fetch**——
//   fetchImpl(url, init)            ≙ legacy :1262 fetch（默认 globalThis.fetch）
//   api(method, path, body)         ≙ legacy :277-279 的**书内相对** api 包装（参谋分支用，:1070）
//   context{getBookId,getChapterId,getConversationId,getConsult}
//                                   ≙ S.currentBook.id／S.currentChapterId／currentConversationId() :12-16／S.consultMode :1060
//                                   注：`getConsult` 为 Plan §4 T1-3「context 参谋开」的落点（legacy 的 S.consultMode
//                                   是模块内状态、无 DOM 可读，只能注入）
//   sink{toast,warn,busy,beginLive,commitMessage,typing,meter,reload,refreshRunStatus,syncWatcher}
//                                   ≙ A.toast／console.warn :1137-1142／updateStopBtn／appendMsg :871／
//                                     参谋 typing 宿主 :1064-1067／refreshCtxMeter :1350／loadChat :1316-1381／
//                                     refreshRunStatus :1374／syncRunWatcher :1379
//   hub（可注入，默认＝上面的 import）／toolLabels（≙ TOOL_LABELS，legacy :1354；Plan §5② 限定本模块只
//   import chat-event-hub.js，故工具中文名表经注入而非 import）／getLastRunSnapshot（≙ :1955/:2051-2060 的
//   lastRunSnapshot，S5-7 由 RunStatus 件供给）／setTimer（默认 globalThis.setTimeout）
//
// 收尾文案与数值常量逐字照 legacy 并导出供测试引用：重试上限 8／间隔 2000／request_id 前缀 'write'／
// 三值 run 文案表 :1369／系统事件长文本 :1403。
import * as hub from "./chat-event-hub.js";

// ---------- 常量（逐字照 legacy，导出供测试与 S5-7 引用） ----------
export const BUSY_RETRY_MAX = 8; // :1275 busyRetry < 8
export const BUSY_RETRY_DELAY_MS = 2000; // :1279
export const REQUEST_ID_PREFIX = "write"; // :1259 newRequestId('write')
export const SOURCE_WRITING = "writing"; // :1085 默认来源
export const CHAT_BUSY_CODE = "CHAT_BUSY"; // :1274
export const PERMANENT_409_FALLBACK = "请求被拒绝"; // :1282
export const DEFAULT_SOURCE = SOURCE_WRITING;

// run 状态文案三值（:1369 字面量内联表，行为零变化地提为常量）
export const RUN_STATUS_LABELS = {
	awaiting_confirmation: "等待作者确认",
	paused: "任务已暂停，尚未完成",
	cancelled: "已停止生成",
};

// 确认卡结算后的系统事件长文本（:1403 逐字）
export const RESUME_SYSTEM_EVENT_TEXT =
	"[确认执行结果·系统事件] 已把执行结果交给 AI，继续之前的任务…（若这是长期剧情决定，建议到「故事台账 → 故事线」沉淀，对话压缩后它仍可被检索）";

export const NO_CONTENT_FALLBACK = "（已发起操作，请查看上方确认卡）"; // :1242
export const NO_REPLY_TOAST = "未收到回复内容"; // :1249
export const QUEUE_TOAST = "上一条回复还在进行中，已排队，稍后自动发出"; // :1115
export const BUSY_RETRY_TOAST = "上一条回复还在进行中，稍候自动重试…"; // :1278
export const STOP_TOAST = "已停止生成"; // :1277/:1388
export const STOP_WAIT_TOAST = "已停止等待"; // :1309
export const DROP_BOOK_TOAST = "有一条排队消息属于另一本书，已丢弃（未发送）"; // :1144
export const DROP_CONV_TOAST =
	"有一条排队消息属于另一个写作会话，已丢弃（未发送）"; // :1138
export const DUP_PHASE_SYNC = "该请求已在另一窗口完成，正在同步…"; // :1291
export const DUP_PHASE_WAIT = "该请求正在另一窗口进行，等待其结果…"; // :1291
export const DUP_WAIT_ERROR_PHASE = "另一窗口发生错误，等待收尾…"; // :1303
export const RECOVERING_TOAST = "输出被截断或连接中断，正在无缝续写…"; // :1348
export const STREAM_FAIL_ERROR = "流式请求失败"; // :1322
export const CONSULT_TYPING_TEXT = "参谋正在分析…"; // :1066
export const CONSULT_PATH = "/consult"; // :1070
// 抗短连加固包 E（2026-09-30）：流 POST 网络级重试次数——fetch 本身 reject（非 AbortError）
// 且未停止、尚未重试过时，同一 body（request_id 不变，幂等由服务端 duplicate JSON 兜底）原样重发。
export const STREAM_FETCH_RETRIES = 1;

export function autoCompactToast(n) {
	// :1349
	return `上下文接近窗口上限，已自动压缩 ${n} 条早期对话`;
}

export function duplicateSyncedToast(finalStatus) {
	// :1315
	return `该请求已在另一窗口${finalStatus === "finished" ? "完成" : "结束"}，已同步最新会话`;
}

export function otherWindowPhase(ev) {
	// :1301
	return `另一窗口：${ev.payload.name || ev.payload.kind}…`;
}

export function toolPhaseText(name, labels) {
	// :1354（TOOL_LABELS[name] || name）
	const table = labels || {};
	return `正在调用工具：${table[name] || name}…`;
}

export function roundPhaseText(round, total) {
	// :1355
	return `正在继续处理（第 ${round || 1}/${total || 1} 轮）…`;
}

// ---------- 传输核心 ----------
export function createChatTransport(deps) {
	const d = deps || {};
	const context = d.context || {};
	const sink = d.sink || {};
	const hubApi = d.hub || hub;
	const toolLabels = d.toolLabels || {};
	const fetchImpl = d.fetchImpl || ((url, init) => globalThis.fetch(url, init));
	const api = d.api;
	const getLastRunSnapshot = d.getLastRunSnapshot || (() => null);

	const callToast = (msg) => {
		if (typeof sink.toast === "function") sink.toast(msg);
	};
	const callWarn = (...args) => {
		if (typeof sink.warn === "function") sink.warn(...args);
		else console.warn(...args);
	};
	const setBusy = (flag) => {
		if (typeof sink.busy === "function") sink.busy(flag);
	};
	const commitMessage = (msg) => {
		if (typeof sink.commitMessage === "function") sink.commitMessage(msg);
	};
	const delay = (ms) =>
		new Promise((resolve) =>
			(d.setTimer || globalThis.setTimeout)(resolve, ms),
		);

	// ≙ chatBusy / chatQueue / chatAbort（:1096-1099）：单飞闸门＝本地队列；在飞流 ≤1（AGENTS.md §4）
	let inFlight = false;
	const queue = [];
	let currentAbort = null;

	function isBusy() {
		return inFlight;
	}

	function queueLength() {
		return queue.length;
	}

	// ≙「停止生成」按钮 :1899（chatAbort.stop('user')）；无在飞句柄时静默
	function stop(reason) {
		if (currentAbort) currentAbort.stop(reason || "user");
	}

	async function sendText(rawContent) {
		// ≙ sendChat :1048-1090：空文本不触发（:1053-1054）；trim 后使用（:1053）
		const content = String(rawContent == null ? "" : rawContent).trim();
		if (!content) return;
		// 参谋模式走 /consult（非流式，建议类回复）——不进队列、不占 abort 句柄（:1059-1081 逐字）
		// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1060 参谋模式守卫（S.consultMode → 注入读取）
		if (context.getConsult && context.getConsult()) {
			commitMessage({ role: "user", content, source: DEFAULT_SOURCE });
			if (typeof sink.typing === "function")
				sink.typing(true, CONSULT_TYPING_TEXT);
			try {
				const data = await api("POST", CONSULT_PATH, {
					question: content,
					chapterId: context.getChapterId ? context.getChapterId() : null,
				});
				if (typeof sink.typing === "function") sink.typing(false);
				commitMessage({
					role: "consultant",
					content: data.reply || "",
					reasoning: data.reasoning || "",
					retrieval: data.retrieval || [],
					source: DEFAULT_SOURCE,
				});
			} catch (e) {
				if (typeof sink.typing === "function") sink.typing(false);
				callToast(e.message);
			}
			return;
		}
		commitMessage({ role: "user", content, source: DEFAULT_SOURCE });
		await runChatStream({
			content,
			chapterId: context.getChapterId ? context.getChapterId() : null,
			source: DEFAULT_SOURCE,
		});
	}

	async function runChatStream(body) {
		// W9（排队切书修复，:1106-1110）：请求在**入队时**绑定书籍 id 与会话 id，执行时校验——
		// 排队期间切了书/会话，该消息属于旧书旧会话，绝不发到新的 /chat/stream 里。
		return enqueueChat({
			body,
			// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1109 (S.currentBook && S.currentBook.id) || null（W9 入队绑定）
			bookId: (context.getBookId && context.getBookId()) || null,
			conversationId:
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1109 currentConversationId()（W9/S3-03 会话绑定）
				(context.getConversationId && context.getConversationId()) || null,
		});
	}

	async function enqueueChat(item) {
		if (inFlight) {
			queue.push(item);
			callToast(QUEUE_TOAST);
			return;
		}
		inFlight = true;
		try {
			await streamChatOnce(item, 0);
		} finally {
			inFlight = false;
			const next = queue.shift();
			// 队列项直接执行：bookId 沿用入队时的绑定，不重读当前书（W9，:1124-1125）
			if (next) enqueueChat(next);
		}
	}

	async function streamChatOnce(item, busyRetry) {
		const body = item.body;
		// W9/S3-03：执行时校验归属（:1134-1146）；会话守卫在前、书籍守卫在后，与 legacy 逐字同序
		const convNow = context.getConversationId
			? context.getConversationId()
			: null;
		if (item.conversationId != null && item.conversationId !== convNow) {
			callWarn(
				"[book-chat] 丢弃排队消息：入队于另一写作会话，当前会话已切换",
				body,
			);
			callToast(DROP_CONV_TOAST);
			return;
		}
		const bookNow = context.getBookId ? context.getBookId() : null;
		if (item.bookId != null && (bookNow == null || bookNow !== item.bookId)) {
			callWarn(
				`[book-chat] 丢弃排队消息：入队于书籍 #${item.bookId}，当前书籍 #${bookNow}，不发到新书的会话`,
				body,
			);
			callToast(DROP_BOOK_TOAST);
			return;
		}
		// 实时气泡（:1148-1157）：骨架/增量合并/滚动节流由 ChatLiveBubble 负责，本函数只推调用
		// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1156 body && body.source（无 source 静默不标）
		const live = sink.beginLive({ source: body && body.source });
		const runAbort = hubApi.createAbort();
		currentAbort = runAbort;
		setBusy(true); // ≙ updateStopBtn（:1220）
		let finalRetrieval = []; // :1221
		const toolEvents = [];
		const actionEvents = [];
		const blocks = []; // 工具块/确认卡：流结束后迁移到正式消息里（:1222）

		// 收尾迁移：live → 正式消息（正常完结 / 用户停止后的部分输出共用一条路，:1224-1254）
		function commitLive(finalContent, finalReasoning, note) {
			live.flush(); // 缓冲区里最后几帧的增量必须在换节点前落盘（:1227）
			live.drop(); // ≙ live.remove()（:1228）
			const content = note
				? finalContent
					? `${finalContent}\n\n（${note}）`
					: `（${note}）`
				: finalContent;
			const base = {
				role: "assistant",
				reasoning: finalReasoning,
				retrieval: finalRetrieval,
				tools: toolEvents.slice(),
				actions: actionEvents.slice(),
				blocks: blocks.slice(),
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1233 { source: body && body.source }
				source: (body && body.source) || null,
			};
			if (content) {
				commitMessage({ ...base, content, note: note || null });
			} else if (blocks.length) {
				// 极端情况：只有工具调用/确认卡，没有正文（:1240-1247）
				commitMessage({
					...base,
					content: NO_CONTENT_FALLBACK,
					reasoning: "",
					note: null,
				});
			} else {
				callToast(note || NO_REPLY_TOAST); // :1249
			}
		}

		try {
			// S2-01：每次提交生成 requestId——网络重试/双击复用同一个（服务端幂等返回既有运行，:1256-1259）
			if (!body.request_id)
				body.request_id = hubApi.newRequestId(REQUEST_ID_PREFIX);
			// S3-03：会话随请求下发（入队守卫已确保与当前会话一致，:1260-1261）
			if (!body.conversationId)
				body.conversationId = item.conversationId || undefined;
			// 抗短连加固包 E（2026-09-30）：流 POST 网络级重试一次——初始 fetchImpl 本身 reject
			//（网络级，非 AbortError；AbortError=用户停止语义，不重试）且未停止、尚未重试过 ⇒
			// 用**同一 body（request_id 不变，幂等由服务端 duplicate JSON 兜底）**原样重发一次；
			// 二次失败抛出走既有 catch。已拿到 Response（任何状态码）一律不重试（409 分支已有
			// 自己的语义，幂等 JSON 分支照常走）。
			let res = null;
			for (let streamFetchAttempt = 0; ; streamFetchAttempt++) {
				try {
					res = await fetchImpl(`/api/books/${bookNow}/chat/stream`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
						signal: runAbort.signal,
					});
					break; // 拿到 Response：无论状态码都不做网络级重试
				} catch (e) {
					if (
						streamFetchAttempt >= STREAM_FETCH_RETRIES ||
						hubApi.isAbortError(e) ||
						runAbort.stopped()
					) {
						throw e;
					}
				}
			}
			// 服务端单飞闸门（:1268-1284）：CHAT_BUSY 是暂时的（重试有意义）；「已续跑过」「动作未结算」
			// 是永久性的（重试 8 次只会白等 16 秒），直接报错退出。
			if (res.status === 409) {
				let payload = null;
				try {
					payload = await res.json();
				} catch (_e) {
					/* 非 JSON 响应按通用错误处理（:1273） */
				}
				const isBusy =
					// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1274 isBusy = payload && payload.error && …
					payload && payload.error && payload.error.code === CHAT_BUSY_CODE;
				if (isBusy && busyRetry < BUSY_RETRY_MAX) {
					live.drop(); // ≙ live.remove()（:1276）
					if (runAbort.stopped()) {
						callToast(STOP_TOAST); // 等待重试期间用户按了停止（:1277）
						return;
					}
					callToast(BUSY_RETRY_TOAST);
					await delay(BUSY_RETRY_DELAY_MS);
					return streamChatOnce(item, busyRetry + 1);
				}
				const msg =
					// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1282 (payload.error.message || payload.error) 兜底形态
					(payload &&
						payload.error &&
						(payload.error.message || payload.error)) ||
					PERMANENT_409_FALLBACK;
				throw new Error(typeof msg === "string" ? msg : PERMANENT_409_FALLBACK);
			}
			// S2-01：重复请求（同 requestId）返回 JSON 而非 SSE（:1285-1321）——不解析成流、不重发业务请求
			if (hubApi.isJsonResponse(res)) {
				let dup = null;
				try {
					dup = await res.json();
				} catch (_e) {
					/* 落入通用错误（:1289） */
				}
				// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1290 幂等重复判别 dup && dup.duplicate
				if (dup && dup.duplicate) {
					live.setPhase(
						dup.status === "finished" ? DUP_PHASE_SYNC : DUP_PHASE_WAIT,
					);
					let finalStatus = dup.status;
					if (hubApi.isActiveStatus(dup.status)) {
						try {
							const fin = await hubApi.waitRunEvents({
								runId: dup.runId,
								sessionKey: dup.sessionKey,
								signal: runAbort.signal,
								onEvent: (ev) => {
									if (ev.type === "phase" && ev.payload && ev.payload.kind) {
										live.setPhase(otherWindowPhase(ev));
									} else if (ev.type === "error") {
										live.setPhase(DUP_WAIT_ERROR_PHASE);
									}
								},
							});
							finalStatus = fin.status;
						} catch (e) {
							if (hubApi.isAbortError(e)) {
								live.setPhase("");
								live.drop();
								callToast(STOP_WAIT_TOAST); // :1309
								return;
							}
							finalStatus = "unknown"; // :1310
						}
					}
					live.setPhase("");
					live.drop();
					callToast(duplicateSyncedToast(finalStatus));
					await sink.reload?.(); // ≙ await loadChat()（:1316）
					return;
				}
				// 非重复 JSON（如 503 RUN_PERSIST_FAILED / 400 参数错）按通用错误处理（:1319-1321）
				throw await hubApi.parseResponseError(res, `请求失败 ${res.status}`);
			}
			if (!res.ok || !res.body) throw new Error(STREAM_FAIL_ERROR); // :1322

			const state = await hubApi.consumeBookStream(res, {
				onDelta: (t) => {
					if (t) {
						live.setPhase(""); // ≙ livePhase 隐藏（:1326）
						live.pushDelta(t);
					}
				},
				onReasoning: (t) => {
					live.pushReasoning(t); // ≙ 去 hidden＋合并落盘（:1328-1331）
				},
				onRetrieval: (hits) => {
					finalRetrieval = hits;
					live.addRetrieval(hits); // ≙ renderRetrieval 插在 .msg-bubble 之前（:1333-1337）
				},
				onTool: (t) => {
					toolEvents.push(t);
					blocks.push({ kind: "tool", payload: t });
					live.addTool(t); // ≙ :1338-1342
				},
				onAction: (a) => {
					actionEvents.push(a);
					blocks.push({ kind: "action", payload: a });
					live.addAction(a); // ≙ :1343-1347
				},
				onRecovering: () => callToast(RECOVERING_TOAST), // :1348
				onAutoCompact: (n) => callToast(autoCompactToast(n)), // :1349
				onDone: (ev) => {
					// biome-ignore lint/complexity/useOptionalChain: 逐字移植 legacy :1350 if (ev && ev.usage) refreshCtxMeter(ev.usage)
					if (ev && ev.usage && typeof sink.meter === "function")
						sink.meter(ev.usage); // ≙ refreshCtxMeter(usage)（:1350）
				},
				onEvent: (ev) => {
					if (ev && ev.type === "phase") {
						live.setPhase(
							ev.kind === "tool"
								? toolPhaseText(ev.name, toolLabels)
								: roundPhaseText(ev.round, ev.total),
						); // :1351-1356
					}
				},
			});

			if (state.errors.length) {
				// 流内错误：保持既有语义——只提示，不落半截消息（:1363-1366）
				live.drop();
				callToast(state.errors[state.errors.length - 1].message);
			} else {
				const finalContent =
					typeof state.finalContent === "string"
						? state.finalContent
						: state.content;
				const runLabel = state.run && RUN_STATUS_LABELS[state.run.status];
				commitLive(
					finalContent,
					state.reasoning,
					state.aborted ? STOP_TOAST : runLabel || null,
				);
			}
			// S4-05：本轮收尾后把服务端运行状态与工具细节搬进任务卡（:1372-1378）
			await sink.refreshRunStatus?.({
				run: state.aborted
					? { status: "cancelled", reason: "user_abort" }
					: state.run || getLastRunSnapshot(),
				tools: state.tools || [],
				toolErrors: [],
			});
			if (typeof sink.syncWatcher === "function") sink.syncWatcher(); // :1379
			// 自动压缩发生过：重新拉取消息列表，渲染归档折叠组（:1380-1381）
			if (state.autoCompact) await sink.reload?.();
		} catch (e) {
			if (runAbort.stopped()) {
				// 用户按了「停止生成」且尚未进入流读取：已流出的部分内容保留为正式消息（:1383-1388）
				live.flush();
				const partial = live.getText();
				if (partial) commitLive(partial, live.getReasoning(), STOP_TOAST);
				else {
					live.drop();
					callToast(STOP_TOAST);
				}
			} else {
				live.drop();
				callToast(e.message);
			}
		} finally {
			// 句柄身份匹配才清（:1394）：并发/重试场景下旧帧不得清掉新帧的句柄与 streaming
			if (currentAbort === runAbort) {
				currentAbort = null;
				setBusy(false);
			}
		}
	}

	// 确认卡结算后自动续跑（:1398-1406）：把执行结果作为系统事件回灌对话
	async function resumeAction(actionId) {
		if (!context.getBookId || context.getBookId() == null) return; // :1402
		commitMessage({
			role: "user",
			content: RESUME_SYSTEM_EVENT_TEXT,
			source: DEFAULT_SOURCE,
		});
		try {
			await runChatStream({
				resumeActionId: actionId,
				chapterId: context.getChapterId ? context.getChapterId() : null,
				source: DEFAULT_SOURCE,
			});
		} catch (_e) {
			/* runChatStream 内部已 toast（:1405） */
		}
	}

	return {
		sendText,
		resumeAction,
		stop,
		isBusy,
		queueLength,
	};
}
