// S5-8（Plan §1.1 G2）：public/legacy/agent.js 块一「受控资源目录」纯逻辑移植（范式 A·判定 C
// 的「块一建设笔」，零生产切换）。与 list_resources／get_resource_summary 同一份目录口径：
// 两条 URL 形状逐字（列表/续读、单件摘要 id 在前 bookId 在后），server/** 零改动。
// 语义逐字对应 legacy 行号：
// - :46-77 十类型白名单标签表／状态表／meta 表／details 表、:280-282 范围类型表
// - :287 类型回落（清 cursor/items）、:299-304 查询串、:306-336 meta 文案十类型
// - :344 列表 URL、:349 读取失败文案、:356-361 提示行、:364-395 行模型与空态
// - :408-410 摘要 URL、:405/:419 加载/失败文案、:443-449 空态、:439-503 预览模型
// 纪律：零 DOM、零 fetch、零全局写入；摘要字段一律按不可信文本处理（只出文本模型，不产 HTML）。
import {
	BOOK_SCOPED_TYPES,
	GLOBAL_SCOPED_TYPES,
	scopeBookTitle,
} from "./agent-scope.js";

// :50（与服务端一致：只有书内类型在书籍范围带 bookId；book/corpus/system 会被 400）
export const BOOK_ID_TYPES = {
	chapter: 1,
	outline: 1,
	character: 1,
	world: 1,
	ledger: 1,
	style: 1,
	task: 1,
};

export const RES_TYPE_LABELS = {
	book: "书籍",
	chapter: "章节",
	outline: "大纲（卷）",
	character: "人物",
	world: "世界观",
	ledger: "事件账本",
	style: "作家卡",
	corpus: "语料元数据",
	task: "任务 / 运行",
	system: "系统能力",
};

export const RES_STATUS_LABELS = {
	active: "在场",
	archived: "已归档",
	locked: "已定稿",
	draft: "草稿",
	stale: "已过期",
	enabled: "启用",
	disabled: "停用",
	ready: "就绪",
	empty: "空",
	canonical: "正典",
	configured: "已配置",
	unconfigured: "未配置",
	deleted: "已删除（回收站）",
	ok: "正常",
	collab: "协作模式",
};

export const RES_META_LABELS = {
	sortOrder: "序号",
	revision: "版本",
	locked: "定稿",
	volumeId: "所属卷",
	charCount: "正文字数",
	summaryChars: "摘要字数",
	outlineChars: "大纲字数",
	stale: "摘要过期",
	chapterCount: "章节数",
	characterCount: "人物数",
	volumeCount: "卷数",
	eventCount: "事件数",
	role: "身份",
	archived: "已归档",
	aliasCount: "别名数",
	relationCount: "关系数",
	importance: "重要性",
	origin: "来源",
	sourceStale: "来源过期",
	pendingProposalCount: "待审提案",
	kind: "类型",
	shared: "共享卡",
	builtin: "内置",
	enabled: "启用",
	ruleCount: "规则条目",
	sampleCount: "范文段数",
	indexedSampleCount: "索引段数",
	lastIndexedAt: "最近索引时间",
	works: "作品",
	hanCount: "汉字数",
	docCount: "文档数",
	jobCount: "蒸馏任务数",
	maskDictVersion: "掩码词表",
	model: "模型",
	modelConfigured: "模型已配置",
	keyConfigured: "密钥已配置",
	thinkingDisabledModels: "关闭思考模型",
	protocol: "协议",
	entry: "入口",
	mode: "模式",
	finishedAt: "结束时间",
	hasConversation: "有会话绑定",
	intro: "简介",
	masterOutlineChars: "总纲字数",
	chapterId: "所属章",
	driftStatus: "偏离状态",
};

export const RES_DETAIL_LABELS = {
	index: "索引",
	note: "备注",
	persona: "人设",
	boundBooks: "绑定书籍",
	summary: "摘要",
	beat: "节拍",
	content: "内容",
	intro: "简介",
	outline: "大纲",
	aliases: "别名",
	jobs: "蒸馏任务",
	driftStatus: "偏离状态",
	conversationId: "会话",
	eventCount: "事件数",
	vectorModel: "向量模型",
	samples: "范文段数",
	indexed: "已索引",
	lastIndexedAt: "最近索引时间",
	stage: "阶段",
	status: "状态",
};

export const RES_EMPTY_HINT = "该类型在当前范围内没有资源（空态，不是错误）。";
export const RES_NO_PAGE_HINT =
	"该类资源没有站内页面，这里只展示元数据与摘要（不提供文件浏览）。";
export const RES_LOADING_TEXT = "正在读取摘要…";
export const RES_EMPTY_TEXT = "没有可展示的摘要。";

// :280-282（返回副本：调用方改动不影响常量）
export function resourceTypesForScope(scope) {
	return (
		scope.kind === "book" ? BOOK_SCOPED_TYPES : GLOBAL_SCOPED_TYPES
	).slice();
}

// :283-296 的回落语义纯函数化：类型不在当前范围类型表 → 取首项并清 cursor/items
export function normalizeResourceView(scope, view) {
	const types = resourceTypesForScope(scope);
	if (types.indexOf(view.resType) < 0) {
		return { resType: types[0], resCursor: null, resItems: [] };
	}
	return {
		resType: view.resType,
		resCursor: view.resCursor,
		resItems: view.resItems,
	};
}

// :299-304：type 恒在且编码；bookId 只在书籍范围且属 BOOK_ID_TYPES 时带；parts 依序追加尾部
export function resourceQuery(scope, resType, parts) {
	const out = [`type=${encodeURIComponent(resType)}`];
	if (scope && scope.kind === "book" && BOOK_ID_TYPES[resType]) {
		out.push(`bookId=${encodeURIComponent(scope.bookId)}`);
	}
	for (const p of parts || []) out.push(p);
	return out.join("&");
}

// :344
export function resourceListUrl(scope, resType, cursor) {
	return `/api/resources?${resourceQuery(
		scope,
		resType,
		cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [],
	)}`;
}

// :306-336：十类型逐条 meta 文案，' · ' 连接，尾部更新时间
export function resourceMetaText(it) {
	const m = it.meta || {};
	const bits = [];
	if (it.type === "chapter" && m.sortOrder != null)
		bits.push(`第${m.sortOrder}章`);
	if (it.type === "style") {
		bits.push(`规则 ${m.ruleCount || 0}`);
		bits.push(`索引 ${m.indexedSampleCount || 0}/${m.sampleCount || 0}`);
		if (m.shared) bits.push("共享卡");
	} else if (it.type === "book") {
		bits.push(`章节 ${m.chapterCount || 0}`);
	} else if (it.type === "outline") {
		bits.push(`大纲 ${m.outlineChars || 0} 字`);
		if (m.stale) bits.push("卷摘要已过期");
	} else if (it.type === "character") {
		bits.push(m.role ? `身份 ${m.role}` : "人物");
		if (m.archived) bits.push("已归档");
	} else if (it.type === "world") {
		bits.push(`设定 ${m.contentChars || 0} 字`);
	} else if (it.type === "ledger") {
		bits.push("事件");
		if (m.chapterId) bits.push(`挂第 ${m.chapterId} 章`);
	} else if (it.type === "task") {
		bits.push(`${m.entry || ""} / ${m.mode || ""}`);
	} else if (it.type === "system") {
		bits.push(m.model || "未配置模型");
	} else if (it.type === "corpus") {
		bits.push(`文档 ${m.docCount || 0}`);
	}
	if (it.updatedAt) bits.push(`更新 ${it.updatedAt}`);
	return bits.join(" · ");
}

// :364-395 行模型：title＝(title||'#id')＋状态中文；metaText＝resourceMetaText
export function resourceRowModel(it) {
	const statusLabel = RES_STATUS_LABELS[it.status] || it.status || "";
	return {
		type: it.type,
		id: it.id,
		title: (it.title || `#${it.id}`) + (statusLabel ? ` · ${statusLabel}` : ""),
		statusLabel,
		metaText: resourceMetaText(it),
	};
}

// :356-361
export function resourceListHint(scope, books, resType, count, hasMore) {
	const scopeText =
		scope.kind === "book" ? `《${scopeBookTitle(books, scope)}》` : "全局资源";
	return (
		`范围：${scopeText} · 类型：${RES_TYPE_LABELS[resType] || resType} · 已列出 ${count} 项` +
		`${hasMore ? "（还有更多）" : ""}。点击任一资源在右侧看摘要与来源，管理操作请到对应工作台。`
	);
}

// :349
export function resourceListFailText(message) {
	return `资源读取失败：${message}`;
}

// :419
export function previewFailText(message) {
	return `摘要读取失败：${message}`;
}

// :408-410：id 在前、bookId 在后（仅书籍范围且属 BOOK_ID_TYPES）
export function resourceDetailUrl(scope, type, id) {
	const parts = [`id=${encodeURIComponent(id)}`];
	if (scope && scope.kind === "book" && BOOK_ID_TYPES[type]) {
		parts.push(`bookId=${encodeURIComponent(scope.bookId)}`);
	}
	return `/api/resources?type=${encodeURIComponent(type)}&${parts.join("&")}`;
}

// :439-503：摘要渲染模型（只用文本，不产 HTML）。deps.onSwitchScope＝book 型「切范围」回调。
export function previewModel(res, deps) {
	if (!res) return null;
	const rows = [
		{ key: "状态", value: RES_STATUS_LABELS[res.status] || res.status || "—" },
	];
	if (res.found === false)
		rows.push({
			key: "说明",
			value: `该引用已不在正典（${res.deletedAt || ""}）`,
		});
	const meta = res.meta || {};
	for (const mk of Object.keys(meta)) {
		let mv = meta[mk];
		if (mv === null || mv === undefined || mv === "") continue;
		if (Array.isArray(mv)) {
			if (!mv.length) continue;
			mv = mv.join("、");
		} else if (typeof mv === "object") {
			mv = JSON.stringify(mv);
		}
		rows.push({ key: RES_META_LABELS[mk] || mk, value: String(mv) });
	}
	const details = res.details || {};
	for (const dk of Object.keys(details)) {
		const dv = details[dk];
		if (dv === null || dv === undefined || dv === "") continue;
		if (Array.isArray(dv)) {
			if (!dv.length) continue;
			rows.push({ key: RES_DETAIL_LABELS[dk] || dk, value: dv.join("、") });
			continue;
		}
		if (typeof dv === "object") {
			for (const sk of Object.keys(dv)) {
				const sv = dv[sk];
				if (sv === null || sv === undefined || sv === "") continue;
				rows.push({
					key: `${RES_DETAIL_LABELS[dk] || dk} · ${RES_DETAIL_LABELS[sk] || sk}`,
					value: String(sv),
				});
			}
			continue;
		}
		rows.push({ key: RES_DETAIL_LABELS[dk] || dk, value: String(dv) });
	}
	const link = res.route
		? {
				href: res.route,
				text: "打开工作台 →",
				title: `站内跳转：${res.route}`,
			}
		: null;
	return {
		title: `${RES_TYPE_LABELS[res.type] || res.type} · ${res.title || `#${res.id}`}`,
		rows,
		found: res.found !== false,
		link,
		noPageHint: res.route ? null : RES_NO_PAGE_HINT,
		isBook: res.type === "book",
		switchScopeValue: res.type === "book" ? `book:${res.id}` : null,
		onSwitchScope: deps ? deps.onSwitchScope : undefined,
	};
}
