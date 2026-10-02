// S5-7（Plan §1.1 G5）：public/legacy/book-chat.js :1655-1842 世界观/人物列表与弹窗的纯逻辑移植。
// 语义逐字对应 legacy 行号：:1661-1671 世界观条目模型（子标题截 30 字）、:1705-1709 弹窗 bodyHTML、
// :1714-1731 保存（标题必填、PUT/POST 分派）、:1740-1752 人物条目模型（子标题＝定位）、
// :1786-1810 六字段弹窗、:1815-1838 保存（姓名必填）、:1687/:1768 删除确认文案。
// 纪律：零 DOM 写、零 fetch；弹窗读取经传入 document；路径一律书内相对（由调用方套 bookApiPath）。
export const WORLD_DELETE_CONFIRM = "确定删除该世界观条目？";
export const CHARACTER_DELETE_CONFIRM = "确定删除该人物卡片？";
export const WORLD_TITLE_REQUIRED_TOAST = "请填写标题";
export const CHARACTER_NAME_REQUIRED_TOAST = "请填写姓名";
export const WORLD_SUB_MAX = 30; // :1671 (entry.content || '').slice(0, 30)
export const CHARACTER_FORM_FIELDS = [
	["ch-name", "姓名", "input", "name"],
	["ch-role", "定位", "input", "role"],
	["ch-appearance", "外貌", "textarea", "appearance"],
	["ch-personality", "性格", "textarea", "personality"],
	["ch-background", "背景", "textarea", "background"],
	["ch-note", "备注", "textarea", "note"],
];

export function worldItemModel(entry) {
	return {
		id: entry.id,
		title: entry.title,
		sub: (entry.content || "").slice(0, WORLD_SUB_MAX),
	};
}

export function characterItemModel(ch) {
	return { id: ch.id, name: ch.name, sub: ch.role || "" };
}

export function worldModalTitle(entry) {
	return entry?.id ? "编辑世界观条目" : "新建世界观条目";
}

export function characterModalTitle(c) {
	return c?.id ? "编辑人物卡片" : "新建人物卡片";
}

// :1707-1709
export function worldModalBodyHTML(entry, escapeHtml) {
	const esc =
		typeof escapeHtml === "function"
			? escapeHtml
			: (s) => String(s == null ? "" : s);
	const e = entry || {};
	return (
		`<label class="field"><span>标题</span><input id="we-title" value="${esc(e.title || "")}"></label>` +
		`<label class="field"><span>内容</span><textarea id="we-content" rows="6">${esc(e.content || "")}</textarea></label>`
	);
}

// :1788-1810
export function characterModalBodyHTML(c, escapeHtml) {
	const esc =
		typeof escapeHtml === "function"
			? escapeHtml
			: (s) => String(s == null ? "" : s);
	const ch = c || {};
	let bodyHTML = "";
	for (const [id, label, tag, key] of CHARACTER_FORM_FIELDS) {
		const val = ch[key] || "";
		bodyHTML += `<label class="field"><span>${label}</span>`;
		bodyHTML +=
			tag === "input"
				? `<input id="${id}" value="${esc(val)}">`
				: `<textarea id="${id}" rows="2">${esc(val)}</textarea>`;
		bodyHTML += "</label>";
	}
	return bodyHTML;
}

function fieldValue(doc, id) {
	const el = doc?.getElementById ? doc.getElementById(id) : null;
	return el ? String(el.value == null ? "" : el.value).trim() : "";
}

// :1715-1716
export function worldFormValues(doc) {
	return {
		title: fieldValue(doc, "we-title"),
		content: fieldValue(doc, "we-content"),
	};
}

// :1816-1828（逐字段显式取值：DOM id 前缀 ch- ＋键名，trim 后原样下发）
export function characterFormValues(doc) {
	return {
		name: fieldValue(doc, "ch-name"),
		role: fieldValue(doc, "ch-role"),
		appearance: fieldValue(doc, "ch-appearance"),
		personality: fieldValue(doc, "ch-personality"),
		background: fieldValue(doc, "ch-background"),
		note: fieldValue(doc, "ch-note"),
	};
}

// :1722-1726
export function worldSaveRequest(entry, values) {
	return {
		method: entry?.id ? "PUT" : "POST",
		path: entry?.id ? `/world/${entry.id}` : "/world",
		body: { title: values.title, content: values.content },
	};
}

// :1830-1834
export function characterSaveRequest(c, values) {
	return {
		method: c?.id ? "PUT" : "POST",
		path: c?.id ? `/characters/${c.id}` : "/characters",
		body: {
			name: values.name,
			role: values.role,
			appearance: values.appearance,
			personality: values.personality,
			background: values.background,
			note: values.note,
		},
	};
}
