// S2-2（charter §5 路由页范式）：ProfilePage 组件——#/profile 渲染委托给 React。
// 逐字等值移植 public/legacy/profile.js（176 行）：
// - JSX 镜像 index.html `.profile-main` 静态标记（结构/class/文本逐字，含 hero 印记条与
//   3 张卡的 desc 文案），7 个 id 槽位与 data-go/data-prompt-book 全保留；静态标记的
//   双维护为已知边界，阶段五随消费页一并清理（Plan §1 非目标）。
// - 数据层逐字移植 loadAll（含 perBook N×2 聚合与 catch 回退），走 getApp().api；
//   弹窗走 getApp().openModal（bodyHTML 内转义用 getApp().escapeHtml），toast 走 getApp().toast。
// - 行点击用 React onClick 等价替代旧页根一次性委托（location.hash = go / openPromptModal）。
// - 每次 mount 以 key=visit++ 重挂重拉——等价旧 show() 每次进入都 setLoading+重拉（D3）。

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";

function esc(s) {
	return getApp().escapeHtml(String(s == null ? "" : s));
}

function fmtWan(n) {
	n = Number(n) || 0;
	return n >= 10000
		? (n / 10000).toFixed(1).replace(/\.0$/, "") + " 万"
		: String(n);
}

// ---------- 拉数（旧 loadAll 逐字移植） ----------
async function loadAll() {
	const A = getApp();
	const booksRes = await A.api("GET", "/api/books");
	const books = booksRes.books || [];
	const globals = await Promise.all([
		A.api("GET", "/api/style-lab/packs").catch(() => ({ packs: [] })),
		A.api("GET", "/api/style-lab/stats").catch(() => ({ stats: null })),
	]);
	// 逐书聚合：字数（delete-preview 里的 words）+ 生效卡链（packs?book_id= 里的 effective）。
	// 书多时是 N×2 个请求，书架量级下可接受；若日后加 server 聚合接口，只换这一段。
	const perBook = await Promise.all(
		books.map((b) =>
			Promise.all([
				A.api(
					"GET",
					"/api/books/" + encodeURIComponent(b.id) + "/delete-preview",
				).catch(() => null),
				A.api(
					"GET",
					"/api/style-lab/packs?book_id=" + encodeURIComponent(b.id),
				).catch(() => null),
			]),
		),
	);
	return {
		books: books,
		packs: globals[0].packs || [],
		stats: globals[1].stats || null,
		perBook: perBook,
	};
}

function Stat({ n, label }) {
	// 旧 statHtml：<div class="profile-stat"><b>{esc(n)}</b><span>{esc(label)}</span></div>
	return (
		<div className="profile-stat">
			<b>{n}</b>
			<span>{label}</span>
		</div>
	);
}

function EmptyRow({ text }) {
	// 旧 emptyRow：<div class="profile-empty">{esc(text)}</div>
	return <div className="profile-empty">{text}</div>;
}

function BookRow({ go, name, children }) {
	// 旧 bookRow + 页根委托的 data-go 分支（location.hash = go）
	return (
		<button
			className="profile-book-row"
			type="button"
			data-go={go}
			onClick={() => {
				location.hash = go;
			}}
		>
			<span className="pbr-name">{name}</span>
			{children}
		</button>
	);
}

export default function ProfilePage() {
	const [data, setData] = useState(null);
	const [error, setError] = useState(null);

	useEffect(() => {
		let alive = true;
		(async () => {
			try {
				const d = await loadAll();
				if (alive) setData(d);
			} catch (e) {
				if (alive) setError(e);
			}
		})();
		return () => {
			alive = false;
		};
	}, []);

	function openPromptModal(book) {
		const A = getApp();
		if (!A || !book) return;
		A.openModal({
			title: "本书系统提示词 · " + book.title,
			bodyHTML:
				'<p class="field-hint">留空则使用全局系统提示词（全局模板在设置页维护）。</p>' +
				'<textarea id="bp-prompt" rows="10">' +
				esc(book.system_prompt || "") +
				"</textarea>",
			onOk: async () => {
				try {
					const val = document.getElementById("bp-prompt").value.trim();
					await A.api("PUT", "/api/books/" + encodeURIComponent(book.id), {
						system_prompt: val,
					});
					book.system_prompt = val;
					// 局部重绘提示词行（等价旧 renderPromptRows(lastData)）
					setData((d) => ({ ...d }));
					A.toast("已保存");
				} catch (e) {
					A.toast(e.message);
					return false;
				}
			},
		});
	}

	// ---------- 三个渲染态的槽位内容（等价旧 setLoading / render / show 的 catch 分支） ----------
	const loading = !data && !error;
	const errTotal = data && data.stats ? Number(data.stats.total) || 0 : 0;

	let statsContent = null;
	let sumCards = "";
	let sumStylelab = "";
	let sumPrompts = "";
	let rowsCards = null;
	let rowsStylelab = null;
	let rowsPrompts = null;

	if (loading) {
		statsContent = (
			<>
				<Stat n="…" label="作品" />
				<Stat n="…" label="作家卡" />
				<Stat n="…" label="错题" />
				<Stat n="…" label="累计字数" />
			</>
		);
		sumCards = "…";
		sumStylelab = "…";
		sumPrompts = "…";
		rowsCards = <EmptyRow text="载入中…" />;
		rowsStylelab = <EmptyRow text="载入中…" />;
		rowsPrompts = <EmptyRow text="载入中…" />;
	} else if (error) {
		const msg = "载入失败：" + (error && error.message ? error.message : error);
		rowsCards = <EmptyRow text={msg} />;
		rowsStylelab = <EmptyRow text={msg} />;
		rowsPrompts = <EmptyRow text={msg} />;
	} else {
		// 创作者印记条
		let totalWords = 0;
		data.perBook.forEach((pb) => {
			if (pb[0] && pb[0].words) totalWords += Number(pb[0].words) || 0;
		});
		statsContent = (
			<>
				<Stat n={data.books.length} label="作品" />
				<Stat n={data.packs.length} label="作家卡" />
				<Stat n={errTotal} label="错题" />
				<Stat n={fmtWan(totalWords)} label="累计字数" />
			</>
		);

		const packName = {};
		data.packs.forEach((p) => {
			packName[p.id] = p.name;
		});
		const noBooks = <EmptyRow text="还没有作品，先去书架新建一部" />;

		// 作家卡：每本书的生效卡链（bound/own=本书指定，basic=兜底，none=未指定）
		sumCards = "卡库 " + data.packs.length + " 张";
		rowsCards = data.books.length
			? data.books.map((b, i) => {
					const eff = data.perBook[i][1] && data.perBook[i][1].effective;
					let meta = <span className="pbr-meta">未指定用卡</span>;
					if (eff && eff.chain_ids && eff.chain_ids.length) {
						const main = eff.main_id ? packName[eff.main_id] || "主卡" : null;
						const auxN = eff.aux_ids ? eff.aux_ids.length : 0;
						const prefix = eff.source === "basic" ? "兜底：" : "";
						meta = (
							<span className="pbr-meta">
								{prefix +
									(main ? main : "仅 " + auxN + " 张辅卡") +
									(main && auxN ? " ＋" + auxN + " 辅" : "")}
							</span>
						);
					}
					const go = "#/book/" + encodeURIComponent(b.id) + "/cards";
					return (
						<BookRow key={b.id} go={go} name={b.title}>
							{meta}
						</BookRow>
					);
				})
			: noBooks;

		// 错题库：全局统计自带 byBook 分布
		const errByBook = {};
		if (data.stats && data.stats.byBook) {
			data.stats.byBook.forEach((r) => {
				errByBook[r.bookId] = r.count;
			});
		}
		sumStylelab = "共 " + errTotal + " 条";
		rowsStylelab = data.books.length
			? data.books.map((b) => {
					const n = errByBook[b.id] || 0;
					return (
						<BookRow
							key={b.id}
							go={"#/book/" + encodeURIComponent(b.id) + "/stylelab"}
							name={b.title}
						>
							<span className={"pbr-chip " + (n ? "on" : "off")}>{n} 条</span>
						</BookRow>
					);
				})
			: noBooks;

		const overridden = data.books.filter(
			(b) => b.system_prompt && b.system_prompt.trim(),
		).length;
		sumPrompts = overridden ? overridden + " 本已覆盖" : "全部跟随全局";
		rowsPrompts = data.books.length
			? data.books.map((b) => {
					const has = !!(b.system_prompt && b.system_prompt.trim());
					return (
						<button
							key={b.id}
							className="profile-book-row"
							type="button"
							data-prompt-book={b.id}
							onClick={() => openPromptModal(b)}
						>
							<span className="pbr-name">{b.title}</span>
							<span className={"pbr-chip " + (has ? "on" : "off")}>
								{has ? "已覆盖" : "跟随全局"}
							</span>
						</button>
					);
				})
			: noBooks;
	}

	return (
		<>
			{/* ↓ 镜像 index.html `.profile-main` 静态标记（hero 印记条） */}
			<section className="profile-hero">
				<div className="profile-seal" aria-hidden="true">
					墨砚
				</div>
				<div className="profile-hero-text">
					<div className="profile-hero-title">创作者印记</div>
					<div className="profile-hero-sub">笔墨所至，皆有留痕</div>
				</div>
				<div id="profile-stats" className="profile-stats">
					{statsContent}
				</div>
			</section>
			<section className="profile-cards">
				<article className="profile-card">
					<div className="profile-card-head">
						<span className="profile-card-mark" aria-hidden="true">
							卡
						</span>
						<h3>作家卡</h3>
						<span className="profile-card-sum" id="profile-sum-cards">
							{sumCards}
						</span>
					</div>
					<p className="profile-card-desc">
						全库文风卡与每本书的用卡情况；点书名进入该书的卡片管理与注入预览。
					</p>
					<div className="profile-book-rows" id="profile-rows-cards">
						{rowsCards}
					</div>
				</article>
				<article className="profile-card">
					<div className="profile-card-head">
						<span className="profile-card-mark" aria-hidden="true">
							错
						</span>
						<h3>错题库</h3>
						<span className="profile-card-sum" id="profile-sum-stylelab">
							{sumStylelab}
						</span>
					</div>
					<p className="profile-card-desc">
						朱雀判为 AI 味的语句标本，按书归档；点书名进入该书的语料复核与导出。
					</p>
					<div className="profile-book-rows" id="profile-rows-stylelab">
						{rowsStylelab}
					</div>
				</article>
				<article className="profile-card">
					<div className="profile-card-head">
						<span className="profile-card-mark" aria-hidden="true">
							词
						</span>
						<h3>本书提示词</h3>
						<span className="profile-card-sum" id="profile-sum-prompts">
							{sumPrompts}
						</span>
					</div>
					<p className="profile-card-desc">
						单本书对全局系统提示词的覆盖；点书名直接编辑，不进工作台。
					</p>
					<div className="profile-book-rows" id="profile-rows-prompts">
						{rowsPrompts}
					</div>
				</article>
			</section>
		</>
	);
}

// ---------- 挂载（app.js:201 经 window.MozhenProfile.mount() 委托至此） ----------
// 目标 #page-profile .profile-main；取不到即返回（dev 壳无此元素时安全 no-op）。
// root 首次创建后复用，每次 mount 以 key=visit++ 重挂——等价旧 show() 每次重拉。
let visit = 0;

export function mount() {
	const el = document.querySelector("#page-profile .profile-main");
	if (!el) return;
	let root = el.__mozhenProfileRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenProfileRoot = root;
	}
	root.render(<ProfilePage key={visit++} />);
}
