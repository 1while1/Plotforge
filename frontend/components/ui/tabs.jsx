import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "../../lib/cn.js";

export function Tabs({ className, ...props }) {
	return (
		<TabsPrimitive.Root
			data-slot="tabs"
			className={cn("flex flex-col", className)}
			{...props}
		/>
	);
}

export function TabsList({ className, ...props }) {
	return (
		<TabsPrimitive.List
			data-slot="tabs-list"
			className={cn(
				"flex items-center gap-0.5 border-b border-border",
				className,
			)}
			{...props}
		/>
	);
}

export function TabsTrigger({ className, ...props }) {
	return (
		<TabsPrimitive.Trigger
			data-slot="tabs-trigger"
			className={cn(
				"-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-3 py-2 font-ui text-[13px] text-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[state=active]:border-primary data-[state=active]:font-semibold data-[state=active]:text-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export function TabsContent({ className, ...props }) {
	return (
		<TabsPrimitive.Content
			data-slot="tabs-content"
			className={cn("min-h-0 flex-1 outline-none", className)}
			{...props}
		/>
	);
}
