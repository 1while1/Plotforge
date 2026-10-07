// S5-9（Plan §1.1 G3）：public/legacy/agent.js 块二「轮次累积 / 请求体组装 / 导入条 / 任务卡取参」
// 纯逻辑移植（范式 A·判定 C 收尾笔）。
// 语义逐字对应 legacy 行号：
// - :1395-1517 consumeStream 的状态半（文本段/思考块/工具块簿记/roundTools 配对/toolErrors/
//   onDone 全文替换/result() trim）
// - :1924-1933 发送体、:1824 续跑体、:600-601 新会话体
// - :1240-1246 legacy 导入体、:1215-1232 导入条两态
// - :2009-2034 统一任务卡取参（pendingActionSummaries / runCardInput / 空判定）
// 纪律：零 DOM、零 fetch（累积器只产出「渲染 op」，DOM 半在 AgentLiveRound.jsx），
// 渲染 op 形状＝组件契约（同一份逻辑同时供 Node 双钉与组件消费，避免双实现漂移）。
import { extractConfirmation } from "./agent-actions.js";
import { scopeBookTitle } from "./agent-scope.js";
import { agentToolLabel } from "./agent-tool-labels.js";

// :1480（工具结果 2000 截断；历史侧 800 截断属 AgentMessageList）
export const TOOL_RESULT_MAX = 2000;

export function truncateToolResult(text) {
	const value = String(text == null ? "" : text);
	return value.length > TOOL_RESULT_MAX
		? `${value.slice(0, TOOL_RESULT_MAX)}\n…（结果过长，已截断）`
		: value;
}

// :1444-1448
export function toolInputText(input) {
	let text = "";
	try {
		text = JSON.stringify(input, null, 2);
	} catch (_e) {
		text = String(input);
	}
	return `入参：${text === "{}" ? "（无）" : text}`;
}

// :1503-1504
export function agentToolErrorMessage(info) {
	const i = info || {};
	return `工具未执行：${i.code ? `[${i.code}] ` : ""}${agentToolLabel(i.toolName)}${
		i.message ? ` — ${i.message}` : ""
	}`;
}

// :1395-1517：累积器只保留状态与「渲染 op」；每个方法返回一个 op（noop 表示本事件不改 DOM）
export function createRoundAccumulator() {
	let fullText = "";
	let segments = [];
	let openSegment = false;
	let reasoningOpen = false;
	let reasoningText = "";
	let doneText = null;
	const blocks = new Map(); // toolCallId -> {toolName, input}
	const roundTools = [];
	const toolErrors = [];
	const pendingEntries = [];

	function onDelta(delta) {
		const text = delta == null ? "" : String(delta);
		fullText += text;
		if (!openSegment) {
			segments.push("");
			openSegment = true;
		}
		segments[segments.length - 1] += text;
		return { kind: "text-append", delta: text };
	}

	function onTextEnd() {
		openSegment = false;
		return { kind: "text-end" };
	}

	function onReasoningStart() {
		reasoningOpen = true;
		reasoningText = "";
		return { kind: "reasoning-open" };
	}

	function onReasoningDelta(delta) {
		if (!reasoningOpen) return { kind: "noop" };
		reasoningText += delta == null ? "" : String(delta);
		return {
			kind: "reasoning-append",
			delta: delta == null ? "" : String(delta),
		};
	}

	function onReasoningEnd() {
		reasoningOpen = false;
		return { kind: "reasoning-end" };
	}

	function onToolCall(tc) {
		const call = tc || {};
		blocks.set(call.toolCallId, {
			toolName: call.toolName,
			input: call.input,
		});
		roundTools.push({ name: call.toolName, args: call.input, result: null });
		openSegment = false; // :1457 工具调用后新起文本气泡
		return {
			kind: "tool-block",
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			inputText: toolInputText(call.input),
		};
	}

	function onToolOutput(to, opts) {
		const out = to || {};
		const block = blocks.get(out.toolCallId);
		if (!block) return { kind: "noop" }; // :1461-1462 无匹配 toolCallId → 忽略
		for (let i = roundTools.length - 1; i >= 0; i--) {
			if (roundTools[i].name === block.toolName && !roundTools[i].result) {
				roundTools[i].result = out.output;
				break;
			}
		}
		const o = opts || {};
		const conf = extractConfirmation(out.output);
		if (conf) {
			const entry = {
				id: conf.id,
				conf: conf,
				toolName: block.toolName,
				input: block.input,
				expiresAt: conf.expires_at || null,
				conversationId: o.conversationId || null,
			};
			pendingEntries.push(entry);
			return {
				kind: "tool-output",
				toolCallId: out.toolCallId,
				statusText: "待作者确认",
				done: false,
				resultText: null,
				confirm: conf,
				pendingEntry: entry,
			};
		}
		const failed = !!(out.output && out.output.ok === false);
		let text = "";
		try {
			text = JSON.stringify(out.output, null, 2);
		} catch (_e) {
			text = String(out.output);
		}
		return {
			kind: "tool-output",
			toolCallId: out.toolCallId,
			statusText: failed ? "未执行或失败" : "完成",
			done: !failed,
			resultText: truncateToolResult(text),
			confirm: null,
			pendingEntry: null,
		};
	}

	function onToolError(info) {
		toolErrors.push(info);
		return {
			kind: "tool-error",
			text: agentToolErrorMessage(info),
			info: info,
		};
	}

	function onDone(result) {
		const text = result && typeof result.text === "string" ? result.text : null;
		if (text === null || text === fullText) return { kind: "noop" };
		fullText = text;
		segments = [text];
		openSegment = false;
		doneText = text;
		return { kind: "text-replace", text: text };
	}

	// :1511-1517 —— 结果形状（extra＝ChatEventHub.consumeAgentStream 的回执）
	function result(extra) {
		const e = extra || {};
		return {
			text: (e.text || fullText).trim(),
			aborted: !!e.aborted,
			run: e.run || null,
			tools: e.tools || roundTools,
			toolErrors: e.toolErrors || toolErrors,
		};
	}

	return {
		onDelta,
		onTextEnd,
		onReasoningStart,
		onReasoningDelta,
		onReasoningEnd,
		onToolCall,
		onToolOutput,
		onToolError,
		onDone,
		result,
		get fullText() {
			return fullText;
		},
		get textSegments() {
			return segments.slice();
		},
		get reasoningText() {
			return reasoningText;
		},
		get doneText() {
			return doneText;
		},
		get roundTools() {
			return roundTools;
		},
		get toolErrors() {
			return toolErrors;
		},
		get pendingEntries() {
			return pendingEntries;
		},
	};
}

// :1924-1933
export function buildSendPayload(input) {
	const i = input || {};
	const payload = {
		conversation_id: i.conversationId,
		content: i.content,
		request_id: i.requestId,
	};
	const scope = i.scope || { kind: "global", bookId: null };
	if (scope.kind === "book" && i.mode === "execute") {
		payload.mode = "execute";
		payload.book_id = scope.bookId;
	}
	if (scope.kind === "book" && i.boundaryChapterId)
		payload.chapterId = i.boundaryChapterId;
	return payload;
}

// :1824（conversation_id 有值才带：`pendingConversationId(cid) || undefined`）
export function buildResumePayload(input) {
	const i = input || {};
	const payload = {};
	if (i.conversationId) payload.conversation_id = i.conversationId;
	payload.request_id = i.requestId;
	return payload;
}

// :600-601
export function buildNewConversationBody(scope, books) {
	const body = {
		kind: "agent",
		scope: scope.kind,
		title:
			scope.kind === "book"
				? `${scopeBookTitle(books, scope)} · 讨论`
				: "全局资源讨论",
	};
	if (scope.kind === "book") body.bookId = scope.bookId;
	return body;
}

// :1240-1246
export function buildLegacyImportBody(legacyHistory) {
	return {
		scope: "global",
		title: "导入的助手历史",
		messages: (legacyHistory || [])
			.filter(
				(m) =>
					m &&
					(m.role === "user" || m.role === "assistant") &&
					typeof m.content === "string" &&
					m.content.trim(),
			)
			.map((m) => ({ role: m.role, content: m.content })),
	};
}

// :1215-1232 —— 导入条两态（visible/text/importHidden/cleanHidden）
export function legacyBarModel(legacyHistory, legacyImported) {
	const list = legacyHistory || [];
	if (!list.length)
		return { visible: false, text: "", importHidden: false, cleanHidden: true };
	if (legacyImported) {
		return {
			visible: true,
			text: `本地旧助手历史 ${list.length} 条已导入服务端。以下可清理浏览器本地副本（服务端历史不受影响）。`,
			importHidden: true,
			cleanHidden: false,
		};
	}
	const first = list[0]?.content ? String(list[0].content).slice(0, 24) : "";
	return {
		visible: true,
		text: `检测到浏览器本地旧助手历史 ${list.length} 条（首条：「${first}…」）。导入为服务端只读历史，不会带入任何工具证据。`,
		importHidden: false,
		cleanHidden: true,
	};
}

// :2009-2019
export function pendingActionSummaries(pendingList) {
	try {
		return (pendingList || []).map((entry) => ({
			id: entry.id,
			conversationId: entry.conversationId || null,
			summary: `${entry.toolName ? agentToolLabel(entry.toolName) : "写操作"}（等你在会话里确认）`,
		}));
	} catch (_e) {
		return [];
	}
}

// :2025-2031 —— RS.cardModel 的取参（键名逐字）
export function runCardInput(input) {
	const i = input || {};
	return {
		run: i.run || null,
		conversationId: i.conversationId || null,
		tools: i.tools || [],
		toolErrors: i.toolErrors || [],
		actions: i.actions || [],
	};
}

// :2032
export function isRunCardEmpty(model) {
	return (
		!model.badge &&
		!model.pendingActions.length &&
		!model.tools.length &&
		!model.toolErrors.length
	);
}
