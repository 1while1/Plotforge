// S5-3（Plan §2.4.3/§2.4.4）：window.App 五方法的 React 侧等价实现——
// public/legacy/app.js:13-116 逐字移植（api 结构化错误信封 / toast 2500ms 单例 timer /
// escapeHtml 五字符 / openModal 全语义 / closeModal）。
//
// 与 legacy 的唯一差异：错误信封的结构化解析**直连 frontend/lib/chat-event-hub.js**
// （import { parseErrorBody }），不再经 window.ChatEventHub 旧名桥——S4-10 先例；
// legacy 的 `window.ChatEventHub ? … : null` 守卫在真实浏览器恒真（旧名桥供给），
// 该差异等价（lib 与旧名桥同一实现）。
// state 对象（P6-2 §2.5-D1 前由 index.html 的 App 供给段创建）现由本模块单例创建/复用，
// 禁止重建对象（legacy book.js:11 `var WB = window.App` 与全站消费方共享同一单例）。
import { parseErrorBody } from "./chat-event-hub.js";

// ---------- 模块单例（P6-2 Plan §2.5-D1） ----------
// 等值 index.html 的 App 供给段（:758-759 建 `window.App` 与 state 三字段）：去全局后由模块单例承接，
// state 对象同样**单例**（禁止重建——legacy book.js:11 `var WB = window.App` 与全站消费方共享同一引用）。
// 消费方一律**调用期**读取（`getApp().api(...)`），禁在模块顶层或构造期缓存 api 引用——
// 否则 runStatus.observeApi() 的猴补（lib/run-status.js:159-186）会落空。
let appSingleton = null;

export function getApp() {
	if (!appSingleton) appSingleton = createAppRuntime();
	return appSingleton;
}

// **仅测试注入面**（生产零调用；静态见证＝本文件唯一写入点）。
// setAppForTests(null) 复位为「下次 getApp() 懒建真实单例」。
export function setAppForTests(instance) {
	appSingleton = instance || null;
	return appSingleton;
}

export function createAppRuntime({ state } = {}) {
	const appState = state || {
		currentBook: null,
		currentChapterId: null,
		currentVolumeId: null,
	};
	let toastTimer = null;

	async function api(method, url, body) {
		const opts = {
			method: method,
			headers: { "Content-Type": "application/json" },
		};
		if (body !== undefined) opts.body = JSON.stringify(body);
		const res = await fetch(url, opts);
		if (!res.ok) {
			let msg = "请求失败";
			let errCode;
			let errDetails;
			try {
				const data = await res.json();
				if (data && data.error !== undefined) {
					// error 可能是字符串，也可能是结构化对象 {code, message, details}
					const parsed = parseErrorBody(data);
					if (parsed) {
						msg = parsed.message;
						errCode = parsed.code;
						errDetails = parsed.details;
					} else {
						msg =
							typeof data.error === "string"
								? data.error
								: // 逐字等值 legacy `(data.error && data.error.message) || JSON.stringify(...)`：
									// data.error 为 null/''/0 等假值时 message 取 undefined，与 && 短路同结果
									data.error?.message || JSON.stringify(data.error);
					}
				}
			} catch (_e) {
				/* ignore */
			}
			const err = new Error(msg);
			if (errCode !== undefined && errCode !== null) err.code = errCode;
			if (errDetails !== undefined) err.details = errDetails;
			err.status = res.status;
			throw err;
		}
		return res.json();
	}

	function toast(msg) {
		const el = document.getElementById("toast");
		el.textContent = msg;
		el.classList.remove("hidden");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			el.classList.add("hidden");
		}, 2500);
	}

	function escapeHtml(s) {
		if (s == null) return "";
		return String(s).replace(
			/[&<>"']/g,
			(c) =>
				({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;",
				})[c],
		);
	}

	function openModal(opts) {
		const mask = document.getElementById("modal-mask");
		document.getElementById("modal-title").textContent = opts.title;
		document.getElementById("modal-body").innerHTML = opts.bodyHTML;
		document.getElementById("modal-ok").textContent = opts.okText || "确定";
		mask.classList.remove("hidden");

		const okBtn = document.getElementById("modal-ok");
		const cancelBtn = document.getElementById("modal-cancel");

		// 危险操作确认：红色按钮；每次打开都重置，避免状态残留
		if (opts.danger) {
			okBtn.classList.add("btn-danger");
		} else {
			okBtn.classList.remove("btn-danger");
		}

		okBtn.onclick = () => {
			// 纯展示弹窗（okText 例如「关闭」、不传 onOk）：直接关，不调用不存在的回调
			if (typeof opts.onOk !== "function") {
				closeModal();
				return;
			}
			const ret = opts.onOk(document.getElementById("modal-body"));
			if (ret && typeof ret.then === "function") {
				ret
					.then((r) => {
						if (r !== false) closeModal();
					})
					.catch(() => {
						/* ignore */
					});
			} else if (ret !== false) {
				closeModal();
			}
		};
		cancelBtn.onclick = closeModal;
		mask.onclick = (e) => {
			if (e.target === mask) closeModal();
		};
	}

	function closeModal() {
		document.getElementById("modal-mask").classList.add("hidden");
	}

	return { state: appState, api, toast, escapeHtml, openModal, closeModal };
}
