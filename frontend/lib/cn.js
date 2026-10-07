import { clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// 自定义主题名需登记，否则 tailwind-merge 会把 font-read 当成字重、和 font-bold 互相吞掉。
const twMerge = extendTailwindMerge({
	extend: {
		theme: {
			font: ["ui", "read", "mono"],
			shadow: ["pop"],
		},
	},
});

export function cn(...inputs) {
	return twMerge(clsx(inputs));
}
