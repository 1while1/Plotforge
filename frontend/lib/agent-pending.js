// S5-9（Plan §1.1 G1）：public/legacy/agent.js 块二「pending 确认卡持久化与重建 + session id」
// 纯逻辑移植（范式 A·判定 C 收尾笔；旧文件在本片 git rm 全退役）。
// 语义逐字对应 legacy 行号：
// - :26-35 稳定会话 id（agent_session_v1：生成/读回/写回；storage 不可用退回内存态）
// - :1274-1287 agent_pending_v1 读写（slice(-20) 截断、损坏 JSON/非数组按空）
// - :1289-1302 pendingConversationId / rememberPending / forgetPending
// - :1304-1331 planPendingRebuild：30 分钟 TTL 过期划分（过期不再进存储）＋同参去重
//   （键＝(toolName||'')+'|'+JSON.stringify(input||{})，后者替换前者且保留在列表尾部）
// 纪律：零 DOM、零 fetch、零全局写入——storage 全注入（缺失/抛错即内存态，不抛）。
export const SESSION_KEY = "agent_session_v1";
export const PENDING_KEY = "agent_pending_v1";
// :1286 slice(-20)
export const PENDING_MAX = 20;

// :27-29 稳定会话 id：'agent:' + 36 进制随机 + ':' + 36 进制时间戳
export function newSessionId(deps) {
	const d = deps || {};
	const random = typeof d.random === "function" ? d.random : Math.random;
	const now = typeof d.now === "function" ? d.now : Date.now;
	return `agent:${random().toString(36).slice(2)}:${now().toString(36)}`;
}

// :30-35：先内存生成，读到键则原样用；无键则写回（storage 抛错→只用内存值，不抛）
export function loadOrCreateSessionId(storage, deps) {
	const generated = newSessionId(deps);
	try {
		const saved = storage.getItem(SESSION_KEY);
		if (saved) return saved;
		storage.setItem(SESSION_KEY, generated);
	} catch (_e) {
		/* localStorage 不可用则退回内存态（:35） */
	}
	return generated;
}

// :1279-1284
export function loadPending(storage) {
	try {
		const list = JSON.parse(storage.getItem(PENDING_KEY) || "[]");
		return Array.isArray(list) ? list : [];
	} catch (_e) {
		return [];
	}
}

// :1285-1287（超限/循环引用等 stringify 抛错一律静默）
export function savePendingList(storage, list) {
	try {
		storage.setItem(
			PENDING_KEY,
			JSON.stringify((list || []).slice(-PENDING_MAX)),
		);
	} catch (_e) {
		/* 超限忽略（:1286） */
	}
}

// :1290-1296：命中即取记录（空值回落 null，不回落到当前会话）；未命中回落当前会话
export function pendingConversationId(storage, cid, currentConversationId) {
	const list = loadPending(storage);
	for (const entry of list) {
		if (entry && entry.id === cid) return entry.conversationId || null;
	}
	return currentConversationId || null;
}

// :1297-1299
export function rememberPending(storage, entry) {
	savePendingList(
		storage,
		loadPending(storage)
			.filter((x) => x.id !== entry.id)
			.concat([entry]),
	);
}

// :1300-1302
export function forgetPending(storage, id) {
	savePendingList(
		storage,
		loadPending(storage).filter((x) => x.id !== id),
	);
}

// :1308-1334 的重建计划（DOM 半归 React 组件/装配 hook）：
// 过期（expiresAt ≤ now）入 expired（渲染只读历史卡后不再进存储）；
// 其余按同参键去重（后者替换前者且保留在尾部）；返回顺序＝原列表序。
export function planPendingRebuild(list, now) {
	const kept = [];
	const expired = [];
	const seen = new Map();
	for (const entry of list || []) {
		// legacy `:1318 if (!entry || !entry.id || !entry.conf) continue;` 的布尔等值写法
		if (!entry?.id || !entry?.conf) continue;
		// entry 未通过上一行守卫即 continue ⇒ 此处的可选链与 legacy `entry.expiresAt &&` 布尔等值
		if (entry?.expiresAt && Date.parse(entry.expiresAt) <= now) {
			expired.push(entry);
			continue;
		}
		const key = `${entry.toolName || ""}|${JSON.stringify(entry.input || {})}`;
		if (seen.has(key)) {
			const prev = kept.indexOf(seen.get(key));
			if (prev >= 0) kept.splice(prev, 1);
		}
		seen.set(key, entry);
		kept.push(entry);
	}
	return { kept, expired };
}
