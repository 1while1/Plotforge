// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root = null;
function mount(node) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	act(() => root.render(node));
	return host;
}

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("ui 基础组件", () => {
	it("cn：自定义字体族与字重并存，同组冲突后者胜", () => {
		expect(cn("font-read font-bold")).toBe("font-read font-bold");
		expect(cn("px-2", "px-4")).toBe("px-4");
		expect(cn("bg-primary", false && "bg-surface")).toBe("bg-primary");
	});

	it("Button：带 data-slot、默认 type=button、变体类生效、外部 class 可覆盖", () => {
		const host = mount(
			<Button variant="primary" className="px-6">
				定稿
			</Button>,
		);
		const btn = host.querySelector("button");
		expect(btn.dataset.slot).toBe("button");
		expect(btn.type).toBe("button");
		expect(btn.className).toContain("bg-primary");
		expect(btn.className).toContain("px-6");
		expect(btn.className).not.toContain("px-3");
	});

	it("Button asChild：把样式交给子元素（链接按钮）", () => {
		const host = mount(
			<Button asChild variant="outline">
				<a href="#/settings">设置</a>
			</Button>,
		);
		const link = host.querySelector("a");
		expect(link.dataset.slot).toBe("button");
		expect(link.className).toContain("border");
		expect(link.hasAttribute("type")).toBe(false);
	});

	it("Tabs：默认值对应面板可见，其余面板不渲染内容", () => {
		const host = mount(
			<Tabs defaultValue="chat">
				<TabsList>
					<TabsTrigger value="chat">对话</TabsTrigger>
					<TabsTrigger value="consult">参谋</TabsTrigger>
				</TabsList>
				<TabsContent value="chat">对话面板</TabsContent>
				<TabsContent value="consult">参谋面板</TabsContent>
			</Tabs>,
		);
		const triggers = host.querySelectorAll('[data-slot="tabs-trigger"]');
		expect(triggers[0].dataset.state).toBe("active");
		expect(triggers[1].dataset.state).toBe("inactive");
		expect(host.textContent).toContain("对话面板");
		expect(host.textContent).not.toContain("参谋面板");
	});
});
