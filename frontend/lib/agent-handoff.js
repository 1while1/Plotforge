// S5-8（Plan §1.1 G3）：public/legacy/agent.js 块一「讨论结论 → 规划笔记 / 显式交接」纯逻辑与
// bodyHTML 移植（范式 A·判定 C 的「块一建设笔」，零生产切换）。
// 语义逐字对应 legacy 行号：
// - :695-697 两段提示常量、:699-702 clipText、:704-716 勾选条、:718-727 toggleMessagePick
// - :729-753 勾选上下文行、:755-758 defaultHandoffText、:760-764 会话名、:767-806 笔记弹窗正文
// - :818-829 writingOptions、:833-843 defaultTargetId、:845-850 boundaryChapterTitle
// - :852-858 handoffTargetHint、:860-898 交接表单 bodyHTML
// - :1023-1052 材料段 / 预览头（:1070-1097）与已交接段（:1056-1068）
// 纪律：零 DOM、零 fetch、零全局写入；唯二 HTML 字符串面＝弹窗 bodyHTML，逐处经注入的 escapeHtml；
// 消息正文/资源字段一律 textContent 语义（调用方直投字符串），本 lib 不产资源面 HTML。
export const HANDOFF_NOTE_HINT =
	"规划笔记只是草稿：不写正文、不改大纲、不进事件账本（不是故事事实）。";
export const HANDOFF_WRITE_HINT =
	"交接只向指定写作会话追加一条注明来源的消息：不改正文/大纲/人物/世界观；" +
	"要改正式资料请在讨论里提出，AI 会生成待审提案，你在确认卡里放行。";

function escOf(escapeHtml) {
	return typeof escapeHtml === "function"
		? escapeHtml
		: (s) => String(s == null ? "" : s);
}

// :699-702
export function clipText(text, max) {
	const value = String(text === undefined || text === null ? "" : text);
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

// :718-727（按 Number(id) 去重、按 id 升序；不原地改入参）
export function togglePick(picks, m, on) {
	const kept = [];
	for (const p of picks || []) {
		if (p.id !== Number(m.id)) kept.push(p);
	}
	if (on)
		kept.push({
			id: Number(m.id),
			role: m.role,
			content: String(m.content || ""),
		});
	kept.sort((a, b) => a.id - b.id);
	return kept;
}

// :729-740 的「已选 N 条」计数（:710）
export function pickCountText(count) {
	return `已选 ${count} 条讨论结论`;
}

// :749-753
export function pickedContextLine(picks) {
	return (picks || [])
		.map(
			(m) =>
				`#${m.id}（${m.role === "user" ? "我" : "助手"}）：${clipText(m.content, 300)}`,
		)
		.join("\n");
}

// :755-758（逐条 trim→过滤空→'\n\n' 连接→slice(0,4000)）
export function defaultHandoffText(picks) {
	return (picks || [])
		.map((m) => String(m.content || "").trim())
		.filter(Boolean)
		.join("\n\n")
		.slice(0, 4000);
}

// :760-764
export function activeConversationLabel(conversation) {
	return conversation ? conversation.title || "未命名会话" : "（未选择会话）";
}

// :818-829（escapeHtml 逐处：id 与 title/后缀）
export function writingOptions(list, selectedId, escapeHtml) {
	const esc = escOf(escapeHtml);
	const out = [];
	if (!selectedId) out.push('<option value="">（请选择写作会话）</option>');
	for (const c of list || []) {
		const archived = c.status === "archived";
		out.push(
			`<option value="${esc(c.id)}"${c.id === selectedId ? " selected" : ""}${
				archived ? " disabled" : ""
			}>` +
				`${esc((c.title || "未命名会话") + (archived ? "（已归档 · 不能交接）" : ""))}</option>`,
		);
	}
	return out.join("");
}

// :833-843（记忆键 writing_conversation_<bookId>；storage 抛错静默）
export function defaultTargetId(list, bookId, storage) {
	let remembered = null;
	try {
		remembered = storage.getItem(`writing_conversation_${bookId}`);
	} catch (_e) {
		/* 忽略（:835） */
	}
	for (const c of list || []) {
		if (c.id === remembered && c.status !== "archived") return remembered;
	}
	for (const c of list || []) {
		if (c.status !== "archived") return c.id;
	}
	return "";
}

// :845-850
export function boundaryChapterTitle(boundaryChapters, chapterId) {
	for (const ch of boundaryChapters || []) {
		if (Number(ch.id) === Number(chapterId))
			return ch.title || `章节 #${chapterId}`;
	}
	return `章节 #${chapterId}`;
}

// :852-858（三分支逐字）
export function handoffTargetHint(s) {
	if (!s.bookId) return "先选目标书，再选该书写作会话（全局讨论不自动挑书）。";
	if (!s.writingList.length)
		return "这本书还没有写作会话：请先在写作页打开该书（会自动建立写作会话），再回来交接。";
	let hit = null;
	for (const c of s.writingList) if (c.id === s.targetId) hit = c;
	return `将交给：《${s.bookTitle || ""}》· ${hit ? hit.title || "未命名会话" : "（未选择会话）"}`;
}

// :860-898（字段快照 s＝{bookScope,bookId,bookTitle,writingList,targetId,picks,chapterId,note}）
export function handoffComposeBodyHTML(s, deps) {
	const d = deps || {};
	const esc = escOf(d.escapeHtml);
	const parts = [];
	parts.push(`<p class="field-hint">${esc(HANDOFF_WRITE_HINT)}</p>`);
	if (s.bookScope) {
		parts.push(
			`<p class="field-hint">目标书：<strong>${esc(s.bookTitle)}</strong>（当前范围；交接不能跨书）</p>`,
		);
	} else {
		const bookOpts = ['<option value="">（请选择目标书）</option>'];
		for (const b of d.books || []) {
			bookOpts.push(
				`<option value="${esc(b.id)}">${esc(b.title || `#${b.id}`)}</option>`,
			);
		}
		parts.push(
			`<label class="field"><span>目标书（全局讨论不会自动挑书）</span><select id="handoff-target-book">${bookOpts.join(
				"",
			)}</select></label>`,
		);
	}
	parts.push(
		`<label class="field"><span>目标写作会话</span><select id="handoff-target-conversation">${
			s.writingList.length
				? writingOptions(s.writingList, s.targetId, esc)
				: '<option value="">（这本书还没有写作会话）</option>'
		}</select></label>`,
	);
	parts.push(
		`<p class="field-hint" id="handoff-target-hint">${esc(handoffTargetHint(s))}</p>`,
	);
	parts.push(
		`<label class="field"><span>交接摘要（可编辑，会写进写作会话）</span><textarea id="handoff-text" rows="4">${esc(
			defaultHandoffText(s.picks),
		)}</textarea></label>`,
	);
	const refs = [];
	if (s.chapterId) {
		refs.push(
			`<label class="field field-inline"><input type="checkbox" id="handoff-ref-chapter" checked> 来源引用：章节《${esc(
				boundaryChapterTitle(d.boundaryChapters, s.chapterId),
			)}》（当前剧情边界）</label>`,
		);
	}
	if (s.note) {
		refs.push(
			`<label class="field field-inline"><input type="checkbox" id="handoff-ref-note" checked> 来源引用：规划笔记《${esc(
				s.note.title || "未命名笔记",
			)}》（revision ${Number(s.note.revision)}）</label>`,
		);
	}
	if (refs.length) {
		parts.push(
			`<div class="field"><span>来源引用（可选：只带目标书内或明确通用的资料）</span>${refs.join(
				"",
			)}</div>`,
		);
	}
	parts.push(
		`<div class="field"><span>材料预览（选定 ${s.picks.length} 条结论）</span><pre class="handoff-preview" id="handoff-material">${esc(
			s.picks.length
				? pickedContextLine(s.picks)
				: "（无选定消息：只交接摘要文本）",
		)}</pre></div>`,
	);
	return parts.join("");
}

// :773-782 的存笔记弹窗正文（默认标题＝clipText(scopeTitle+' · 讨论纪要',200)；
// 正文＝逐条 trim 直接 join（与 defaultHandoffText 的过滤空不同，逐字照 :780））
export function noteModalBodyHTML(scopeTitle, picks, escapeHtml) {
	const esc = escOf(escapeHtml);
	const defaultTitle = clipText(`${scopeTitle} · 讨论纪要`, 200);
	const text = (picks || [])
		.map((m) => String(m.content || "").trim())
		.join("\n\n")
		.slice(0, 4000);
	return (
		`<p class="field-hint">${esc(HANDOFF_NOTE_HINT)}</p>` +
		`<label class="field"><span>标题</span><input id="agent-note-title" type="text" value="${esc(
			defaultTitle,
		)}"></label>` +
		`<label class="field"><span>笔记正文（可编辑）</span><textarea id="agent-note-text" rows="6">${esc(
			text,
		)}</textarea></label>` +
		`<p class="field-hint">来源：本轮勾选的 ${(picks || []).length} 条讨论消息（${esc(
			(picks || []).map((m) => `#${m.id}`).join("、"),
		)}）</p>`
	);
}

// :1023-1052
export function handoffMaterialHTML(view, escapeHtml) {
	const esc = escOf(escapeHtml);
	const material = view?.material || {};
	const parts = [];
	parts.push(
		`<div class="field"><span>交接摘要</span><pre class="handoff-preview" id="handoff-preview-text">${esc(
			material.text || "（无摘要文本）",
		)}</pre></div>`,
	);
	const excerpts = material.excerpts || [];
	parts.push(
		`<div class="field"><span>选定结论（${excerpts.length} 条）</span><ul>${
			excerpts.length
				? excerpts
						.map(
							(item) =>
								`<li>#${esc(item.messageId)}（${esc(item.role === "user" ? "我" : "助手")}）：${esc(
									clipText(item.excerpt, 500),
								)}${item.truncated ? "……（原文更长，已截断）" : ""}</li>`,
						)
						.join("")
				: "<li>（无：只交接摘要文本）</li>"
		}</ul></div>`,
	);
	const refs = material.sourceRefs || [];
	parts.push(
		`<div class="field"><span>来源引用（${refs.length}）</span><ul>${
			refs.length
				? refs
						.map((ref) => {
							if (ref.kind === "general")
								return `<li>通用资料：${esc(ref.label || "")}</li>`;
							return `<li>${esc(ref.kind === "chapter" ? "章节" : "规划笔记")} #${esc(ref.id)}${
								ref.title ? `《${esc(ref.title)}》` : ""
							}（revision ${esc(ref.revision)}）</li>`;
						})
						.join("")
				: "<li>（无引用）</li>"
		}</ul></div>`,
	);
	parts.push(
		`<p class="field-hint">来源指纹：<code>${esc(
			view?.sourceFingerprint || "（来源已变更，需重新预览）",
		)}</code></p>`,
	);
	return parts.join("");
}

// :1070-1097 预览头＋按钮区（acceptDisabled＝busy||stale；关闭弹窗＝不交接）
export function handoffPreviewBodyHTML(view, escapeHtml) {
	const esc = escOf(escapeHtml);
	const target = view?.target || {};
	const busy = !!target.busy;
	const stale = !!view.sourceChanged || !view.sourceFingerprint;
	const head = [];
	if (busy) {
		head.push(
			'<p class="field-hint"><strong>⚠ 目标会话正在运行中：等这一轮结束再接受</strong>（不会混进正在发给模型的请求）。运行结束后点「重新预览」再交接。</p>',
		);
	} else if (stale) {
		head.push(
			`<p class="field-hint"><strong>⚠ 来源已变更：${esc(
				view.sourceIssue || "需要重新预览",
			)}</strong></p>`,
		);
	} else {
		head.push('<p class="field-hint">目标会话空闲，可接受。</p>');
	}
	head.push(
		`<p class="field-hint">接受后只向 <strong>${esc(
			target.title || "写作会话",
		)}</strong> 追加一条注明来源的消息（${esc(HANDOFF_WRITE_HINT)}）</p>`,
	);
	const html =
		head.join("") +
		handoffMaterialHTML(view, esc) +
		'<div class="msg-actions" style="margin-top:8px">' +
		`<button type="button" id="btn-handoff-accept" class="btn btn-small btn-primary"${
			busy || stale ? " disabled" : ""
		}>接受交接（写入写作会话）</button>` +
		'<button type="button" id="btn-handoff-refresh" class="btn btn-small btn-ghost">重新预览</button>' +
		'<button type="button" id="btn-handoff-cancel" class="btn btn-small btn-ghost">作废草案</button>' +
		"</div>" +
		'<p class="field-hint">关闭本窗口＝不交接：草案保留为草稿，不写入任何内容。</p>' +
		'<p class="field-hint">「作废草案」只作废这份还没交接的草案（未向写作会话写入任何内容，且不撤回任何已写进写作会话的消息）。</p>';
	return { html, acceptDisabled: busy || stale, busy, stale };
}

// :1056-1068 已交接（stage='done'）正文
export function handoffDoneBodyHTML(view, escapeHtml) {
	const esc = escOf(escapeHtml);
	const target = view?.target || {};
	return (
		`<p class="field-hint">已交接到 <strong>${esc(
			target.title || "写作会话",
		)}</strong>：消息 #${esc(
			view.acceptedMessageId || view.messageId || "",
		)}（重复点击不会再插入第二条）。</p>` +
		`<p class="field-hint">${esc(HANDOFF_WRITE_HINT)}</p>` +
		handoffMaterialHTML(view, esc)
	);
}
