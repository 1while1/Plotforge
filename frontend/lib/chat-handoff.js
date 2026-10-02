// S5-7（Plan §1.1 G2）：public/legacy/book-chat.js :65-275 前情引用与交接回跳纯逻辑移植。
// 语义逐字对应 legacy 行号：:70-71 两个落点键、:74-81 selectedEditorText（真实选区，不猜）、
// :83-95 handoffRefs/handoffIdAnchor、:96-101 handoffTitle（服务端 title 上限 200）、
// :102-105 handoffMaterial、:106-112 pickCharacter（String 比较）、:144-157 讨论弹窗 bodyHTML、
// :164-179 讨论 onOk 请求体与 toast、:205-219 parseHandoffSource、:239-241 落点键、
// :269-271 来源块逐字、:225/:235/:247 三条回跳 toast。
// 纪律：零 DOM 写、零 fetch、零全局写；选区只经传入的 document 读。
export const HANDOFF_PREFIX = "【来自 Agent 讨论·显式交接】";
export const AGENT_SCOPE_KEY = "agent_scope_v1";
export const AGENT_CONVERSATION_KEY = "agent_conversation_v1";
export const DISCUSS_OK_TOAST_WITH_TEXT =
	"已在 AI 助手开启整体讨论（只带了这本书与你选中的文字）";
export const DISCUSS_OK_TOAST_PLAIN =
	"已在 AI 助手开启整体讨论（未带写作历史）";
export const NO_ORIGIN_TOAST =
	"这条交接消息没有可识别的来源会话 id（材料仍在会话里可读）";
export const ORIGIN_GONE_TOAST =
	"来源讨论会话已不存在：交接消息与材料仍在写作会话里，可照常阅读";
export const ORIGIN_JUMP_TOAST = "已跳到来源讨论（来源与引用见消息下方）";

// :58 同款文案（失败 toast 前缀由调用方拼接）
export function discussFailToast(message) {
	return `另开整体讨论失败：${message}`;
}

// :74-81（无元素/未选/空选区一律空串；越界由 slice 自然收敛）
export function selectedEditorText(doc) {
	if (!doc || typeof doc.getElementById !== "function") return "";
	const el = doc.getElementById("chapter-content");
	if (!el) return "";
	const start = Number(el.selectionStart);
	const end = Number(el.selectionEnd);
	if (!(end > start)) return "";
	return String(el.value || "")
		.slice(start, end)
		.trim();
}

// :83-88
export function handoffRefs(book, chapter, character) {
	let refs = `《${book.title || `#${book.id}`}》`;
	if (chapter) refs += ` · 《${chapter.title || `章节 #${chapter.id}`}》`;
	if (character) refs += ` · 人物：${character.name}`;
	return refs;
}

// :90-95
export function handoffIdAnchor(book, chapter, character) {
	const bits = [`bookId=${book.id}`];
	if (chapter) bits.push(`chapterId=${chapter.id}`);
	if (character) bits.push(`characterId=${character.id}`);
	return `[${bits.join(" ")}]`;
}

// :96-101
export function handoffTitle(book, chapter, character) {
	let t = `《${book.title || `#${book.id}`}》· 整体讨论`;
	if (chapter) t += ` · 自《${chapter.title || `章节 #${chapter.id}`}》`;
	if (character) t += ` · 人物：${character.name}`;
	return t.slice(0, 200); // 服务端 title 上限 200
}

// :102-105
export function handoffMaterial(book, chapter, character, text) {
	return (
		`【来自写作页·整体讨论】${handoffRefs(book, chapter, character)} ${handoffIdAnchor(book, chapter, character)}` +
		`\n以下为作者在写作页明确选中的文字：\n${text}`
	);
}

// :106-112
export function pickCharacter(list, value) {
	if (!value) return null;
	for (const item of Array.isArray(list) ? list : []) {
		if (String(item.id) === String(value)) return item;
	}
	return null;
}

// :207-219
export function parseHandoffSource(content) {
	const text = String(content || "");
	if (text.indexOf(HANDOFF_PREFIX) !== 0) return null;
	const head = /来源会话：([\s\S]*?)（([0-9a-zA-Z-]{8,64})）/.exec(text);
	let refs = [];
	const refLine = /来源引用：([^\n]*)/.exec(text);
	if (refLine) {
		refs = refLine[1]
			.split("｜")
			.map((s) => s.trim())
			.filter(Boolean);
	}
	return {
		originConversationId: head ? head[2] : "",
		originTitle: head ? head[1] : "",
		refs,
	};
}

// :239-241 回跳落点键（书籍范围否则全局）
export function handoffScopeKey(origin) {
	return origin && origin.scope === "book" && origin.book_id
		? `book:${origin.book_id}`
		: "global";
}

// :269-271「来源与引用」details 正文
export function handoffRefsText(info) {
	const head = info.originTitle
		? `来源会话：${info.originTitle}（${info.originConversationId}）\n`
		: "";
	return head + (info.refs || []).join("\n");
}

// :164-166 新专题请求体
export function discussionBody(book, chapter, character) {
	return {
		kind: "agent",
		scope: "book",
		bookId: book.id,
		title: handoffTitle(book, chapter, character),
	};
}

// :168-171 初始材料请求体（只有明确选中的文字才成为材料）
export function handoffMessageBody(book, chapter, character, selected) {
	return {
		content: handoffMaterial(book, chapter, character, selected),
		source: "writing",
	};
}

// :114-118 讨论对象列表
export async function loadHandoffCharacters(bookId, api) {
	try {
		const res = await api("GET", `/api/books/${bookId}/characters`);
		return res.characters || [];
	} catch (_e) {
		return [];
	}
}

// :144-157 讨论弹窗 bodyHTML（escapeHtml 由调用方注入＝legacy A.escapeHtml）
export function discussBodyHTML(input) {
	const { book, chapter, characters, selected, escapeHtml } = input || {};
	const esc =
		typeof escapeHtml === "function"
			? escapeHtml
			: (s) => String(s == null ? "" : s);
	const list = Array.isArray(characters) ? characters : [];
	const previewMaterial = selected
		? handoffMaterial(book, chapter, null, selected)
		: "";
	const characterOptions = list
		.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
		.join("");
	return (
		`<p class="field-hint">将在 <strong>AI 助手</strong> 的《${esc(book.title || "")}》范围新开一个讨论专题草案：<br><strong>${esc(
			handoffTitle(book, chapter, null),
		)}</strong></p>` +
		'<p class="field-hint">默认<strong>不带</strong>写作助手里的对话历史——两个空间的会话各自独立。只有你在这里明确选中的文字才会作为初始材料带过去。</p>' +
		(selected
			? `<label class="field field-inline"><input type="checkbox" id="agent-discuss-quote" checked> 带上我在正文里选中的 ${selected.length} 字作为初始材料</label>` +
				`<pre class="handoff-preview" id="agent-discuss-preview">${esc(previewMaterial)}</pre>`
			: '<p class="field-hint">当前没有选中文字：本次只带去这本书与当前章（不复制任何写作历史）。想带材料，先在正文里选中一段再来。</p>') +
		(list.length
			? `<label class="field"><span>讨论对象（可选，会写进专题名与来源行）</span><select id="agent-discuss-character"><option value="">不指定</option>${characterOptions}</select></label>`
			: "")
	);
}
