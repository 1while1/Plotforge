// S3-2（charter §5）：diff 引擎——public/legacy/diff.js 的逐字移植
// （esc/splitLines/lcsAlign/charDiff 纯函数语义一个字节都不改逻辑）。
// 新增 buildDiffBlocks（D2）：返回结构化分块，替代旧 renderDiff 的 HTML 字符串拼装——
// {type:'same', text}｜{type:'pair', old:parts, new:parts}｜{type:'del', text}｜
// {type:'ins', text}；pair＝连续 del/ins 块按 min(dels.length, inss.length) 配对、每对经
// charDiff（合并相邻同类、m*n>40000 整段退化），parts 为 [{text, kind:'same'|'del'|'ins'}]。
// 分块分组语义与旧 renderDiff（diff.js:78~106）逐字等价：same 行独立成块；跨组不合并。
// 渲染层见 components/DiffOverlay.jsx 的 DiffBody（React 自动转义，esc 不进 JSX 路径）。

// ---------- 工具 ----------
export function esc(s) {
	return String(s).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);
}

// 按行（空行忽略）切分段落
export function splitLines(text) {
	return String(text)
		.split(/\n+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

// 经典 LCS（行级），返回对齐操作序列
export function lcsAlign(a, b) {
	const m = a.length;
	const n = b.length;
	const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] =
				a[i] === b[j]
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			ops.push({ type: "same", oldLine: a[i], newLine: b[j] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			ops.push({ type: "del", oldLine: a[i] });
			i++;
		} else {
			ops.push({ type: "ins", newLine: b[j] });
			j++;
		}
	}
	while (i < m) {
		ops.push({ type: "del", oldLine: a[i] });
		i++;
	}
	while (j < n) {
		ops.push({ type: "ins", newLine: b[j] });
		j++;
	}
	return ops;
}

// 字级 LCS，返回 [{text, kind}] kind: same/del/ins
export function charDiff(oldStr, newStr) {
	const a = [...oldStr];
	const b = [...newStr];
	const m = a.length;
	const n = b.length;
	// 超长段落退化为整段替换，避免 O(m*n) 爆内存
	if (m * n > 40000) {
		return [
			{ text: oldStr, kind: "del" },
			{ text: newStr, kind: "ins" },
		];
	}
	const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] =
				a[i] === b[j]
					? dp[i + 1][j + 1] + 1
					: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const parts = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) {
			parts.push({ text: a[i], kind: "same" });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			parts.push({ text: a[i], kind: "del" });
			i++;
		} else {
			parts.push({ text: b[j], kind: "ins" });
			j++;
		}
	}
	while (i < m) {
		parts.push({ text: a[i], kind: "del" });
		i++;
	}
	while (j < n) {
		parts.push({ text: b[j], kind: "ins" });
		j++;
	}
	// 合并相邻同类
	const merged = [];
	for (const p of parts) {
		if (merged.length && merged[merged.length - 1].kind === p.kind)
			merged[merged.length - 1].text += p.text;
		else merged.push({ ...p });
	}
	return merged;
}

// ---------- 结构化分块（D2 新增；替代 renderDiff 的 HTML 拼装） ----------
export function buildDiffBlocks(oldText, newText) {
	const ops = lcsAlign(splitLines(oldText), splitLines(newText));
	const blocks = [];
	let i = 0;
	while (i < ops.length) {
		const op = ops[i];
		if (op.type === "same") {
			blocks.push({ type: "same", text: op.oldLine });
			i++;
			continue;
		}
		// 收集连续 del/ins 组成变更块并配对（与旧 renderDiff:89~95 同构）
		const dels = [];
		const inss = [];
		while (i < ops.length && ops[i].type !== "same") {
			if (ops[i].type === "del") dels.push(ops[i].oldLine);
			else inss.push(ops[i].newLine);
			i++;
		}
		const pairs = Math.min(dels.length, inss.length);
		for (let k = 0; k < pairs; k++) {
			// pair.old/pair.new 共享同一 parts 数组（与旧 renderDiff 复用一次 charDiff 一致）
			const parts = charDiff(dels[k], inss[k]);
			blocks.push({ type: "pair", old: parts, new: parts });
		}
		for (let k = pairs; k < dels.length; k++)
			blocks.push({ type: "del", text: dels[k] });
		for (let k = pairs; k < inss.length; k++)
			blocks.push({ type: "ins", text: inss[k] });
	}
	return blocks;
}
