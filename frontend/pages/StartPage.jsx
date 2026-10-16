// 开始界面（#/start，打开项目时的默认落点）：一方墨砚悬在云海，每本书按真实数据长成一片浮空群岛，
// 机器人向导「砚灵」可对话。三维场景按需动态加载；WebGL 不可用时退回列表，入口功能不缺。
// 路由页范式同 ShelfPage：整容器接管 #page-start，每次进入重挂重拉；离开时 unmount 释放 GPU。
import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
	formatWords,
	settlementTier,
	TIER_NAMES,
} from "../lib/world-terrain.js";
import { GuidePanel } from "./start/GuidePanel.jsx";

let visit = 0;

const WEATHER_HINTS = {
	clear: "三日内动过笔，天朗气清",
	cloudy: "有些日子没写了，云层渐厚",
	mist: "许久未动笔，砚池起雾落雨",
};

function prefersReducedMotion() {
	return (
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

function bookHref(id) {
	return `#/book/${encodeURIComponent(id)}`;
}

function relativeDay(text) {
	if (!text) return "";
	const t = new Date(String(text).replace(" ", "T"));
	if (Number.isNaN(t.getTime())) return "";
	const days = Math.floor((Date.now() - t.getTime()) / 86400000);
	if (days <= 0) return "今天动过笔";
	if (days === 1) return "昨天动过笔";
	if (days < 30) return `${days} 天前动过笔`;
	return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} 动过笔`;
}

function WorldCard({ world, index, total, onStep }) {
	if (!world) {
		return (
			<section className="start-card is-empty" aria-label="沙盘还空着">
				<p className="start-eyebrow">沙盘还空着</p>
				<h2 className="start-card-title">第一座岛等你落笔</h2>
				<p className="start-card-intro">
					在书架新建一本书，它会在砚池上空长成一座浮空岛：每一卷是一座岛，章节越多聚落越大，人物在岛上走动，设定立成地标。
				</p>
				<div className="start-card-actions">
					<a className="start-btn is-gilt" href="#/">
						去书架新建
					</a>
				</div>
			</section>
		);
	}
	const regions = Array.isArray(world.regions) ? world.regions : [];
	const facts = [
		{ key: "town", label: "聚落", value: world.chapters, unit: "章" },
		{ key: "folk", label: "小人", value: world.characters, unit: "人" },
		{ key: "mark", label: "地标", value: world.worldEntries, unit: "条设定" },
	];
	return (
		<section
			className="start-card"
			aria-label={`《${world.title}》`}
			aria-live="polite"
		>
			<p className="start-eyebrow">
				{relativeDay(world.updatedAt) || "最近一座"}
				<span aria-hidden="true"> · </span>
				{formatWords(world.words)}
			</p>
			<h2 className="start-card-title">{world.title || "未命名"}</h2>
			{world.intro ? <p className="start-card-intro">{world.intro}</p> : null}
			<dl className="start-facts">
				{facts.map((f) => (
					<div key={f.key} className={`start-fact is-${f.key}`}>
						<dt>{f.label}</dt>
						<dd>
							<b>{f.value || 0}</b>
							{f.unit}
						</dd>
					</div>
				))}
			</dl>
			{regions.length > 1 ? (
				<ul className="start-regions" aria-label="各卷岛屿">
					{regions.map((r) => (
						<li key={`${r.title}-${r.chapters}-${r.words}`}>
							{r.title || "本卷"}
							<span>{TIER_NAMES[settlementTier(r.chapters)]}</span>
						</li>
					))}
				</ul>
			) : null}
			{world.lastChapterTitle ? (
				<p className="start-card-last">最近一章「{world.lastChapterTitle}」</p>
			) : (
				<p className="start-card-last">还没有章节，进去写下第一章。</p>
			)}
			<div className="start-card-actions">
				<a className="start-btn is-gilt" href={bookHref(world.id)}>
					进入这本书
				</a>
				{total > 1 ? (
					<span className="start-stepper">
						<button
							type="button"
							className="start-btn is-quiet"
							onClick={() => onStep(-1)}
							aria-label="上一座岛"
						>
							‹
						</button>
						<span className="start-step-count">
							{index + 1}/{total}
						</span>
						<button
							type="button"
							className="start-btn is-quiet"
							onClick={() => onStep(1)}
							aria-label="下一座岛"
						>
							›
						</button>
					</span>
				) : null}
			</div>
		</section>
	);
}

function FallbackList({ worlds, selectedId, onSelect }) {
	return (
		<ul className="start-fallback">
			{worlds.map((w) => (
				<li key={w.id}>
					<button
						type="button"
						className={String(w.id) === String(selectedId) ? "is-selected" : ""}
						onClick={() => onSelect(w.id)}
						onDoubleClick={() => {
							window.location.hash = bookHref(w.id);
						}}
					>
						<span className="start-island-name">{w.title}</span>
						<span className="start-island-meta">{w.chapters} 章</span>
					</button>
				</li>
			))}
		</ul>
	);
}

export function StartPage() {
	const [worlds, setWorlds] = useState(null);
	const [loadError, setLoadError] = useState(null);
	const [selectedId, setSelectedId] = useState(null);
	const [sceneMode, setSceneMode] = useState("loading");
	const [atmosphere, setAtmosphere] = useState(null);
	const stageRef = useRef(null);
	const sceneRef = useRef(null);
	const inputRef = useRef(null);
	const guideStateRef = useRef("idle");

	useEffect(() => {
		let alive = true;
		fetch("/api/start/worlds")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`读取失败 ${r.status}`)),
			)
			.then((data) => {
				if (!alive) return;
				const list = Array.isArray(data?.worlds) ? data.worlds : [];
				setWorlds(list);
				setSelectedId(list.length ? list[0].id : null);
			})
			.catch((e) => {
				if (!alive) return;
				setLoadError(e.message || "读取失败");
				setWorlds([]);
			});
		return () => {
			alive = false;
		};
	}, []);

	const enter = useCallback((id) => {
		window.location.hash = bookHref(id);
	}, []);

	const focusGuide = useCallback(() => {
		inputRef.current?.focus();
	}, []);

	useEffect(() => {
		if (!worlds || !stageRef.current) return;
		let disposed = false;
		let handle = null;
		import("./start/world-scene.js")
			.then((mod) => {
				if (disposed || !stageRef.current) return;
				if (!mod.webglAvailable()) {
					setSceneMode("fallback");
					return;
				}
				handle = mod.createWorldScene(stageRef.current, {
					worlds,
					reducedMotion: prefersReducedMotion(),
					onSelect: (id) => setSelectedId(id),
					onEnter: enter,
					onRobot: focusGuide,
					onAtmosphere: setAtmosphere,
				});
				sceneRef.current = handle;
				handle.setGuideState(guideStateRef.current);
				setSceneMode("ready");
			})
			.catch((e) => {
				console.error("[start] 三维沙盘加载失败", e);
				if (!disposed) setSceneMode("fallback");
			});
		return () => {
			disposed = true;
			sceneRef.current = null;
			handle?.dispose();
		};
	}, [worlds, enter, focusGuide]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 场景就绪后补一次选中态
	useEffect(() => {
		sceneRef.current?.setSelected(selectedId);
	}, [selectedId, sceneMode]);

	const onGuideState = useCallback((s) => {
		guideStateRef.current = s;
		sceneRef.current?.setGuideState(s);
	}, []);

	const list = worlds || [];
	const index = Math.max(
		0,
		list.findIndex((w) => String(w.id) === String(selectedId)),
	);
	const selected = list.length ? list[index] : null;

	const step = useCallback(
		(delta) => {
			if (!list.length) return;
			const next = list[(index + delta + list.length) % list.length];
			setSelectedId(next.id);
		},
		[list, index],
	);

	// 方向键换岛（输入框内不拦截）；回车由岛名按钮与「进入这本书」各自处理
	useEffect(() => {
		const onKey = (e) => {
			const tag = e.target?.tagName;
			if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
			const page = document.getElementById("page-start");
			if (!page || page.classList.contains("hidden")) return;
			if (document.querySelector("[role=dialog]")) return;
			if (e.key === "ArrowRight" || e.key === "ArrowDown") {
				e.preventDefault();
				step(1);
			} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
				e.preventDefault();
				step(-1);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [step]);

	return (
		<div
			className="start"
			data-scene={sceneMode}
			data-daypart={atmosphere?.daypart}
		>
			<div className="start-stage" ref={stageRef}>
				{sceneMode === "loading" ? (
					<p className="start-stage-hint" role="status">
						正在磨墨，沙盘马上铺开…
					</p>
				) : null}
			</div>

			<header className="start-head">
				<span className="start-seal" aria-hidden="true">
					墨砚
				</span>
				<span className="start-brand">AI 小说工坊</span>
				{atmosphere ? (
					<span className="start-sky" title={WEATHER_HINTS[atmosphere.weather]}>
						{atmosphere.label}
						<small>{WEATHER_HINTS[atmosphere.weather]}</small>
					</span>
				) : null}
				<a className="start-btn is-ghost start-shelf-link" href="#/">
					进入书架
					<span aria-hidden="true"> →</span>
				</a>
			</header>

			<div className="start-title">
				<h1>掌中世界</h1>
				<p>一卷一岛，写多少，长多少</p>
			</div>

			{sceneMode === "fallback" && list.length ? (
				<FallbackList
					worlds={list}
					selectedId={selectedId}
					onSelect={setSelectedId}
				/>
			) : null}

			<div className="start-dock">
				<div className="start-dock-left">
					{loadError ? (
						<p className="start-load-error" role="alert">
							书籍统计读取失败（{loadError}）。可以先进入书架继续写。
						</p>
					) : null}
					{worlds ? (
						<WorldCard
							world={selected}
							index={index}
							total={list.length}
							onStep={step}
						/>
					) : null}
					<ul className="start-legend" aria-label="地貌图例">
						<li className="is-isle">岛＝卷</li>
						<li className="is-town">聚落＝章节</li>
						<li className="is-folk">小人＝人物</li>
						<li className="is-mark">地标＝设定</li>
						<li className="is-gem">晶石＝每五条设定</li>
					</ul>
				</div>
				<GuidePanel
					focusBookId={selected ? selected.id : null}
					focusTitle={selected ? selected.title : ""}
					onStateChange={onGuideState}
					inputRef={inputRef}
				/>
			</div>
		</div>
	);
}

export function mount() {
	const el = document.getElementById("page-start");
	if (!el) return;
	let root = el.__mozhenStartRoot;
	if (!root) {
		root = createRoot(el);
		el.__mozhenStartRoot = root;
	}
	visit += 1;
	root.render(<StartPage key={visit} />);
}

export function unmount() {
	const el = document.getElementById("page-start");
	const root = el?.__mozhenStartRoot;
	if (!root) return;
	root.render(null);
}
