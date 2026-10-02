// Toast 基础件（S3-1 D3）：命令式 showToast，接管既有 #toast 节点
// （index.html:829），行为与 public/legacy/app.js:52~61 的 toast() 逐字等价：
// textContent 写入 → 去 hidden → clearTimeout(模块级 timer) → setTimeout(2500) 加回
// hidden。不进 window（本片无 legacy 消费方需要 toast 桥，Plan D1）。
let toastTimer = null;

export function showToast(msg) {
	const el = document.getElementById("toast");
	el.textContent = msg;
	el.classList.remove("hidden");
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		el.classList.add("hidden");
	}, 2500);
}
