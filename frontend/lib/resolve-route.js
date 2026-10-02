// S5-3（Plan §2.4.1）：hash 路由解析纯函数——public/legacy/app.js:119-223 route() 的
// 逐字移植（匹配顺序 workbench → timeline → cards → stylelab → read → book 本体 →
// profile → settings → agent → 兜底重定向；decode 容错、readxyz 前缀语义、query 形态全对位）。
// 返回结构：{ kind, pageId, rawHash, bookId, chapterId, characterId, redirect }——
// kind = workbench|timeline|cards|stylelab|read|book|profile|settings|agent|shelf|redirect；
// redirect 非 null 时页面层语义＝「先全 hidden 再 location.hash='#/'」（push，不可 replace）。
//
// 与 legacy 的差异备案：legacy 在 route() 内命令式直接 decode+委托；本函数只做判定，
// 显隐与委托在 AppRouter 的 Route effect 中执行（「先全 hidden 再显目标＋守卫式委托」）。
const REDIRECT = "#/";

function redirect(rawHash) {
	return {
		kind: "redirect",
		pageId: null,
		rawHash,
		bookId: null,
		chapterId: null,
		characterId: null,
		redirect: REDIRECT,
	};
}

function route(kind, pageId, rawHash, extra) {
	return {
		kind,
		pageId,
		rawHash,
		bookId: null,
		chapterId: null,
		characterId: null,
		redirect: null,
		...(extra || {}),
	};
}

export function resolveRoute(rawHash) {
	const hash = rawHash || "#/";

	if (/^#\/book\/[^/]+\/workbench\//.test(hash)) {
		return route("workbench", "page-workbench", hash);
	}

	const timelineMatch = hash.match(
		/^#\/book\/([^/?]+)\/characters\/([^/?]+)\/timeline/,
	);
	if (timelineMatch) {
		let tlBookId = "";
		let tlCid = "";
		try {
			tlBookId = decodeURIComponent(timelineMatch[1]);
			tlCid = decodeURIComponent(timelineMatch[2]);
		} catch (_e) {
			tlBookId = "";
			tlCid = "";
		}
		if (!tlBookId || !tlCid) return redirect(hash);
		return route("timeline", "page-timeline", hash, {
			bookId: tlBookId,
			characterId: tlCid,
		});
	}

	const cardsMatch = hash.match(/^#\/book\/([^/?]+)\/cards/);
	if (cardsMatch) {
		let cdBookId = "";
		try {
			cdBookId = decodeURIComponent(cardsMatch[1]);
		} catch (_e) {
			cdBookId = "";
		}
		if (!cdBookId) return redirect(hash);
		return route("cards", "page-cards", hash, { bookId: cdBookId });
	}

	const labMatch = hash.match(/^#\/book\/([^/?]+)\/stylelab/);
	if (labMatch) {
		let labBookId = "";
		try {
			labBookId = decodeURIComponent(labMatch[1]);
		} catch (_e) {
			labBookId = "";
		}
		if (!labBookId) return redirect(hash);
		return route("stylelab", "page-stylelab", hash, { bookId: labBookId });
	}

	const readMatch = hash.match(/^#\/book\/([^/?]+)\/read(?:\/([^/?]+))?/);
	if (readMatch) {
		let rdBookId = "";
		let rdCid = null;
		try {
			rdBookId = decodeURIComponent(readMatch[1]);
			if (readMatch[2])
				rdCid = Number.parseInt(decodeURIComponent(readMatch[2]), 10) || null;
		} catch (_e) {
			rdBookId = "";
		}
		if (!rdBookId) return redirect(hash);
		return route("read", "page-read", hash, {
			bookId: rdBookId,
			chapterId: rdCid,
		});
	}

	if (hash.indexOf("#/book/") === 0) {
		let id = "";
		try {
			id = decodeURIComponent(hash.split("/")[2] || "");
		} catch (_e) {
			id = "";
		}
		if (!id) return redirect(hash);
		return route("book", "page-book", hash, { bookId: id });
	}

	if (hash === "#/profile") return route("profile", "page-profile", hash);
	if (hash === "#/settings") return route("settings", "page-settings", hash);
	if (hash === "#/agent") return route("agent", "page-agent", hash);
	if (hash !== "#/") return redirect(hash);
	return route("shelf", "page-shelf", hash);
}
