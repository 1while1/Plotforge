// S5-3（Plan §2.4.5）：ShelfPage 书架页整页 React——public/legacy/app.js:226-280 renderShelf
// ＋ :397-505 init 的回收站/恢复预览全流程的等值移植（静态壳镜像 index.html:11-52）。
//
// 等值要点（行号＝legacy app.js）：
// - renderShelf :226-280：GET /api/books → data.books||[]；空态切 #shelf-empty；book-card 结构
//   逐字（data-id/h3 escapeHtml/book-intro 兜底「暂无简介」/meta `${chapter_count||0} 章 · ${updated_at.slice(5,10)}`/
//   button.icon-btn.book-del）；点卡进书 `#/book/:id`；.book-del 优先且不冒泡到卡。
// - 删除流程 :258-269：GET delete-preview → confirm 强制展示将失去的内容统计 → DELETE → toast
//   「已删除，备份已入回收站」→ 重拉；取消则零请求。
// - 新建作品 :399-421：bodyHTML 两字段、空名 toast「请填写作品名称」返回 false、POST 后
//   `#/book/:id`。
// - 回收站 :469-505：GET recycle-bin → 列表弹窗（标题含 retention_days||30、条目 file/title/
//   created_at/size KB、data-restore/data-purge）→ `#modal-body .recycle-list` 委托；永久删除
//   confirm「永久删除这份备份？删除后无法找回。」→ DELETE（encode）→ toast → 关窗 → 重开列表。
// - 恢复预览 :428-467：POST preview → 行文案（含 legacy 备份/绑定存在性三态）→ okText 两态 →
//   POST restore（file＋allow_partial_style）→ 三态 toast → 重拉。
//
// 静态 markup 双维护为已知边界（S4-2 CardsPage / S5-1 ReadPage 先例）：React 整容器接管
// #page-shelf 后在运行时覆盖它，静态 markup 保留供 CSS/巡检/对照。
// 弹窗经 getApp().openModal 命令式渲染进 #modal-body（共享壳，不纳入 React 树——
// 与 S5-1/S5-2 先例一致），列表按钮用原生委托（等值 :488-504）。

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { getApp } from "../lib/app-runtime.js";

let visit = 0;

function app() {
	return getApp();
}

function booksFrom(data) {
	// 逐字等值 legacy `data.books || []`（api 成功路径 data 恒对象；?. 与 && 短路同结果）
	return data?.books || [];
}

function recycleItemHtml(b) {
	const e = app().escapeHtml;
	return (
		`<div class="recycle-item" data-file="${e(b.file)}">` +
		`<div><strong>《${e(b.title)}》</strong>` +
		`<small>${new Date(b.created_at).toLocaleString()} · ${Math.max(1, Math.round(b.size / 1024))} KB</small></div>` +
		`<div><button class="btn btn-primary btn-small" data-restore="${e(b.file)}">整册恢复</button> ` +
		`<button class="btn btn-ghost btn-small" data-purge="${e(b.file)}">永久删除</button></div>` +
		`</div>`
	);
}

export default function ShelfPage() {
	const [books, setBooks] = useState([]);

	const load = useCallback(async () => {
		try {
			const data = await app().api("GET", "/api/books");
			setBooks(booksFrom(data));
		} catch (e) {
			app().toast(e.message);
		}
	}, []);

	// 仅首次挂载拉取（key=visit++ 重挂即重拉，等值旧 route() 每次进入 renderShelf）
	useEffect(() => {
		load();
	}, [load]);

	async function deleteBook(book) {
		try {
			const preview = await app().api(
				"GET",
				`/api/books/${book.id}/delete-preview`,
			);
			const stats =
				`${preview.chapters} 章 · 约 ${preview.words} 字 · ${preview.characters} 个人物 · ` +
				`${preview.events} 条事实事件 · ${preview.versions} 份版本快照 · ${preview.messages} 条对话`;
			const ok = confirm(
				`确定删除《${book.title}》？\n\n将失去：${stats}\n\n删除前会自动导出整册备份进回收站（保留 30 天，可在书架右上角「回收站」恢复）。`,
			);
			if (!ok) return;
			await app().api("DELETE", `/api/books/${book.id}`);
			app().toast("已删除，备份已入回收站");
			load();
		} catch (err) {
			app().toast(err.message);
		}
	}

	function openNewBookModal() {
		app().openModal({
			title: "新建作品",
			bodyHTML:
				'<label class="field"><span>作品名称</span><input id="nb-title" placeholder="请输入作品名称"></label>' +
				'<label class="field"><span>作品简介</span><textarea id="nb-intro" rows="3" placeholder="可选"></textarea></label>',
			onOk: async (body) => {
				const title = body.querySelector("#nb-title").value.trim();
				if (!title) {
					app().toast("请填写作品名称");
					return false;
				}
				const intro = body.querySelector("#nb-intro").value.trim();
				try {
					const data = await app().api("POST", "/api/books", {
						title: title,
						intro: intro,
					});
					window.location.hash = `#/book/${data.book.id}`;
				} catch (e) {
					app().toast(e.message);
					return false;
				}
			},
		});
	}

	async function previewAndRestore(file) {
		let pv;
		try {
			pv = await app().api("POST", "/api/books/recycle-bin/preview", {
				file: file,
			});
		} catch (e) {
			app().toast(e.message);
			return;
		}
		const e = app().escapeHtml;
		const st = pv.style || {};
		const counts = pv.counts || {};
		const rows = [];
		rows.push(
			`<p>《${e(pv.book.title)}》· 备份于 ${new Date(pv.exported_at).toLocaleString()}</p>`,
		);
		rows.push(
			`<p class="field-hint">将恢复：${counts.chapters || 0} 章 · ${counts.chapter_versions || 0} 个历史版本 · ${counts.messages || 0} 条对话。向量索引在后台自动补建。</p>`,
		);
		if (st.legacy) {
			rows.push(
				'<p class="field-hint" style="color:var(--danger)">这是旧版备份，不含作家卡绑定：</p>',
			);
			(st.unavailable || []).forEach((s) => {
				rows.push(`<p class="field-hint">· 不可恢复：${e(s)}</p>`);
			});
		} else {
			rows.push('<p class="field-hint">作家卡绑定：</p>');
			(st.bindings || []).forEach((b) => {
				rows.push(
					`<p class="field-hint">· ${b.role === "main" ? "主卡" : "辅卡"}《${e(b.pack_name)}》` +
						(b.exists
							? " —— 已就绪"
							: " —— <strong>卡已删除</strong>，恢复后该绑定留空，可新建卡后重绑") +
						"</p>",
				);
			});
			if (!(st.bindings || []).length)
				rows.push('<p class="field-hint">（本书删除时未绑定作家卡）</p>');
		}
		const hasMissing = (st.missing || []).length > 0;
		app().openModal({
			title: "恢复预览",
			bodyHTML: rows.join(""),
			okText: hasMissing ? "仍要恢复（缺失绑定留空）" : "确认恢复",
			onOk: async () => {
				try {
					const res = await app().api(
						"POST",
						"/api/books/recycle-bin/restore",
						{ file: file, allow_partial_style: hasMissing },
					);
					let msg = `已恢复《${pv.book.title}》到书架`;
					const rs = res.style || {};
					if (rs.legacy) msg += "（旧版备份：作家卡绑定不可恢复）";
					else if ((rs.missing || []).length)
						msg += `（绑定缺 ${rs.missing.length} 项，待新建卡重绑）`;
					else msg += `（作家卡绑定 ${rs.restored_bindings || 0} 项已恢复）`;
					app().toast(msg);
					load();
					return true;
				} catch (e) {
					app().toast(e.message);
					return false;
				}
			},
		});
	}

	async function openRecycleBin() {
		let data;
		try {
			data = await app().api("GET", "/api/books/recycle-bin");
		} catch (e) {
			app().toast(e.message);
			return;
		}
		const list = data.backups || [];
		app().openModal({
			title: `回收站（保留 ${data.retention_days || 30} 天）`,
			bodyHTML: list.length
				? `<div class="recycle-list">${list.map(recycleItemHtml).join("")}</div>`
				: '<p class="empty-hint">回收站是空的。删除书籍时会自动在这里生成整册备份。</p>',
			onOk: () => {},
		});
		const box = document.querySelector("#modal-body .recycle-list");
		if (!box) return;
		box.onclick = async (ev) => {
			const rBtn = ev.target.closest("[data-restore]");
			const pBtn = ev.target.closest("[data-purge]");
			try {
				if (rBtn) {
					await previewAndRestore(rBtn.dataset.restore);
				} else if (pBtn) {
					if (!confirm("永久删除这份备份？删除后无法找回。")) return;
					await app().api(
						"DELETE",
						`/api/books/recycle-bin/${encodeURIComponent(pBtn.dataset.purge)}`,
					);
					app().toast("备份已永久删除");
					app().closeModal();
					openRecycleBin(); // 等值 :501 binBtn.click()：关窗后重新打开列表
				}
			} catch (err) {
				app().toast(err.message);
			}
		};
	}

	return (
		<>
			<header className="topbar">
				<div className="brand">
					<svg
						aria-hidden="true"
						className="brand-mark"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5v13z" />
						<path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
					</svg>
					<h1>墨砚</h1>
					<span className="brand-sub">AI 小说工坊</span>
				</div>
				<nav className="topbar-actions">
					<a href="#/agent" className="btn btn-ghost">
						<svg
							aria-hidden="true"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						>
							<path d="M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.2-2.5 5.5-.9.9-1.5 2-1.5 3.5H9c0-1.5-.6-2.6-1.5-3.5C6.2 13.2 5 11.4 5 9a7 7 0 0 1 7-7z" />
							<path d="M9 21h6" />
						</svg>
						AI 助手
					</a>
					<a href="#/profile" className="btn btn-ghost">
						<svg
							aria-hidden="true"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						>
							<circle cx="12" cy="8" r="3.6" />
							<path d="M4.8 20c1.6-3.8 4.1-5.6 7.2-5.6s5.6 1.8 7.2 5.6" />
						</svg>
						个人中心
					</a>
					<a href="#/settings" className="btn btn-ghost">
						<svg
							aria-hidden="true"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
						>
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
						</svg>
						设置
					</a>
				</nav>
			</header>

			<main className="shelf-main">
				<div className="shelf-head">
					<h2>我的书架</h2>
					<div>
						<button
							id="btn-recycle-bin"
							type="button"
							className="btn btn-ghost"
							title="删除的书会自动备份并保留 30 天"
							onClick={openRecycleBin}
						>
							回收站
						</button>
						<button
							id="btn-new-book"
							type="button"
							className="btn btn-primary"
							onClick={openNewBookModal}
						>
							新建作品
						</button>
					</div>
				</div>
				<div id="book-grid" className="book-grid">
					{books.map((book) => {
						const updated = (book.updated_at || "").slice(5, 10);
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: 等值 legacy 的 div 点卡跳转（:252-275），不新增可访问性行为
							// biome-ignore lint/a11y/useKeyWithClickEvents: 同上
							<div
								className="book-card"
								data-id={book.id}
								key={book.id}
								onClick={() => {
									window.location.hash = `#/book/${book.id}`;
								}}
							>
								<h3>{book.title}</h3>
								<p className="book-intro">{book.intro || "暂无简介"}</p>
								<div className="book-meta">
									<span>
										{book.chapter_count || 0} 章 · {updated}
									</span>
									<button
										type="button"
										className="icon-btn book-del"
										title="删除"
										onClick={(e) => {
											e.stopPropagation();
											deleteBook(book);
										}}
									>
										×
									</button>
								</div>
							</div>
						);
					})}
				</div>
				<div
					id="shelf-empty"
					className={`empty-state${books.length ? " hidden" : ""}`}
				>
					<p>书架还是空的</p>
					<p className="empty-hint">点击「新建作品」开始你的第一部小说</p>
				</div>
			</main>
		</>
	);
}

// 路由页范式（S4-2/S5-1 先例）：整容器接管 #page-shelf，key=visit++ 每次进入重挂重拉
// （等值 app.js 每次 route() → renderShelf()）；容器缺失 no-op。
export function mount() {
	const el = document.getElementById("page-shelf");
	if (!el) return;
	let root = el.__mozhenShelfRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenShelfRoot = root;
	}
	visit += 1;
	root.render(<ShelfPage key={visit} />);
}
