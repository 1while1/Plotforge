// S2-1 红测：Vite dev server 对存量渠道（/api SSE 流、/api JSON、/legacy 静态）的透传保障。
// 断言语义（Plan §4）：SSE 分块到达时序（无缓冲）、事件完整性、代理键形状、dev 入口 HTML。
// fixture 为本机 node http server，零外部服务（charter 快速层口径：回归门禁，非真实渠道验收）。

import { createServer as createHttpServer } from "node:http";
import { createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SSE_PATH = "/api/sse/fixture";
const HEALTH_BODY = '{"ok":true}';
const LEGACY_BODY =
	"// legacy chat-event-hub.js stub (dev-proxy test)\nwindow.__LEGACY_HUB__ = true;\n";
const SSE_CHUNK_GAP_MS = 150; // fixture 写出间隔
const MIN_ARRIVAL_GAP_MS = 50; // 相邻事件到达间隔下限（3 倍容差抗 Windows 定时抖动）
const FIRST_CHUNK_BUDGET_MS = 2000; // 首 chunk 预算（无缓冲则应即时到达）

const SSE_MESSAGES = [
	'data: {"type":"content","text":"c1"}\n\n',
	'data: {"type":"content","text":"c2"}\n\n',
	'data: {"type":"content","text":"c3"}\n\n',
	'data: {"type":"done"}\n\n',
];

function startFixture() {
	const emitTimes = [];
	const server = createHttpServer((req, res) => {
		const url = new URL(req.url, "http://fixture.local").pathname;
		if (url === SSE_PATH) {
			res.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				"Cache-Control": "no-cache",
			});
			let i = 0;
			const writeNext = () => {
				if (i >= SSE_MESSAGES.length) {
					res.end();
					return;
				}
				res.write(SSE_MESSAGES[i]);
				emitTimes.push(process.hrtime.bigint());
				i += 1;
				setTimeout(writeNext, SSE_CHUNK_GAP_MS);
			};
			writeNext();
		} else if (url === "/api/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(HEALTH_BODY);
		} else if (url === "/legacy/chat-event-hub.js") {
			res.writeHead(200, { "Content-Type": "application/javascript" });
			res.end(LEGACY_BODY);
		} else {
			res.writeHead(404);
			res.end("not found");
		}
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				server,
				emitTimes,
				origin: `http://127.0.0.1:${server.address().port}`,
			});
		});
	});
}

let fixture = null;
let viteServer = null;
let viteOrigin = "";
let loadedConfig = null;

beforeAll(async () => {
	fixture = await startFixture();
	// 关键：代理键形状取自真实 config（import('../vite.config.mjs')），仅覆写 target 与端口，
	// 保证绿测锁的是真实配置形状而非测试自造代理。
	loadedConfig = (await import("../vite.config.mjs")).default;
	viteServer = await createServer({
		configFile: false,
		logLevel: "error",
		root: loadedConfig.root,
		base: loadedConfig.base,
		plugins: loadedConfig.plugins,
		publicDir: loadedConfig.publicDir,
		build: loadedConfig.build,
		server: {
			...loadedConfig.server,
			port: 0,
			strictPort: true,
			proxy: Object.fromEntries(
				Object.entries(loadedConfig.server.proxy).map(([key, value]) => [
					key,
					{ ...value, target: fixture.origin },
				]),
			),
		},
	});
	await viteServer.listen();
	// 注意：resolvedUrls.local[0] 是面向用户的地址，含 base 前缀（如 http://127.0.0.1:PORT/app/）；
	// 程序化取裸 origin，否则 /api/* 拼成 /app/api/* 不匹配代理键（实测踩坑，见台账）。
	viteOrigin = new URL(viteServer.resolvedUrls.local[0]).origin;
}, 30000);

afterAll(async () => {
	if (viteServer) await viteServer.close();
	if (fixture) fixture.server.close();
});

async function readSseEvents(res) {
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const arrivals = []; // 每个完整 data 事件的到达时刻与文本
	const startedAt = performance.now();
	let firstChunkAt = null;
	let readerDone = false;
	while (!readerDone) {
		const { value, done } = await reader.read();
		if (done) {
			readerDone = true;
			break;
		}
		if (firstChunkAt === null) firstChunkAt = performance.now() - startedAt;
		buffer += decoder.decode(value, { stream: true });
		let idx = buffer.indexOf("\n\n");
		while (idx >= 0) {
			const raw = buffer.slice(0, idx);
			buffer = buffer.slice(idx + 2);
			if (raw.startsWith("data:")) {
				arrivals.push({
					at: performance.now() - startedAt,
					text: raw.slice(5).trim(),
				});
			}
			idx = buffer.indexOf("\n\n");
		}
	}
	return { arrivals, firstChunkAt, readerDone };
}

describe("S2-1 vite dev 代理与存量渠道透传", () => {
	it("T1: SSE 经 dev 代理分块透传（时序无缓冲、事件完整、正常收尾）", async () => {
		const res = await fetch(`${viteOrigin}${SSE_PATH}`);
		expect(res.status).toBe(200);
		// ① content-type 原样透传
		expect(res.headers.get("content-type")).toContain("text/event-stream");

		const { arrivals, firstChunkAt } = await readSseEvents(res);

		// ② 恰 4 个 data 事件（3×content + 1×done）且 JSON 可解析
		expect(arrivals).toHaveLength(4);
		const parsed = arrivals.map((a) => JSON.parse(a.text));
		expect(parsed.map((p) => p.type)).toEqual([
			"content",
			"content",
			"content",
			"done",
		]);
		expect(parsed.map((p) => p.text)).toEqual(["c1", "c2", "c3", undefined]);

		// ③ 相邻事件到达间隔 ≥50ms：代理若整段缓冲则 4 事件几乎同时到达（间隔≈0）即失败
		const gaps = arrivals.slice(1).map((a, i) => a.at - arrivals[i].at);
		for (const gap of gaps) {
			expect(gap).toBeGreaterThanOrEqual(MIN_ARRIVAL_GAP_MS);
		}

		// ④ 首 chunk 距 fetch 发起 <2000ms（首包即时、无缓冲）
		expect(firstChunkAt).toBeLessThan(FIRST_CHUNK_BUDGET_MS);

		// ⑤ done 后连接正常关闭（readSseEvents 循环已完整退出，无需额外断言）
	}, 20000);

	it("T2: 真实 config 代理键形状覆盖 /api 与 /legacy，经代理取到一致内容", async () => {
		const proxyKeys = Object.keys(loadedConfig.server.proxy);
		// D3：仅 5 条存量路径的正则键，无 "/" 全局代理、无 /app 代理
		expect(proxyKeys).toHaveLength(1);
		const re = new RegExp(proxyKeys[0]);
		expect(re.test("/api/health")).toBe(true);
		expect(re.test("/legacy/chat-event-hub.js")).toBe(true);
		expect(re.test("/app/entry.js")).toBe(false);
		expect(re.test("/@vite/client")).toBe(false);

		const health = await fetch(`${viteOrigin}/api/health`);
		expect(health.status).toBe(200);
		expect(await health.text()).toBe(HEALTH_BODY);

		const legacy = await fetch(`${viteOrigin}/legacy/chat-event-hub.js`);
		expect(legacy.status).toBe(200);
		expect(await legacy.text()).toBe(LEGACY_BODY);
	}, 20000);

	it("T3: dev server 可起且 / 返回静态壳 HTML（P6-3 转写：dev 壳退役 ⇒ 唯一形态＝Vite HTML entry）", async () => {
		expect(viteServer.resolvedUrls).toBeTruthy();
		expect(viteServer.resolvedUrls.local.length).toBeGreaterThan(0);

		const res = await fetch(`${viteOrigin}/`, {
			headers: { accept: "text/html" },
		});
		expect(res.status).toBe(200);
		const html = await res.text();
		// P6-3 T-B1 转写（charter §2 豁免流程；对象消失型，逐条留案）：旧断言 `id="app-root"`
		// （dev 壳内置挂载点）随 dev 壳退役消失——静态壳锚改钉驱动依赖的 id（page-shelf/toast），
		// 入口引用由「产物路径 /app/entry」改「Vite entry 声明 /entry.jsx」（dev 形态；
		// 产物形态 /app/entry.js 见 vite.config base＋entryFileNames，由构建门禁见证）。
		expect(html).toContain('id="page-shelf"');
		expect(html).toContain('id="toast"');
		expect(html).toContain("/entry.jsx");
	}, 20000);
});
