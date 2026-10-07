import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "../../lib/cn.js";

export function Command({ className, ...props }) {
	return (
		<CommandPrimitive
			data-slot="command"
			className={cn(
				"flex h-full w-full flex-col overflow-hidden rounded-xl bg-popover font-ui text-popover-foreground",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandDialog({
	title = "跳转",
	open,
	onOpenChange,
	children,
	...props
}) {
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay
					data-slot="command-overlay"
					className="fixed inset-0 z-[1200] bg-black/30"
				/>
				<DialogPrimitive.Content
					data-slot="command-dialog"
					className="fixed top-[14vh] left-1/2 z-[1200] w-[min(600px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-xl border border-border shadow-pop outline-none"
					aria-describedby={undefined}
				>
					<DialogPrimitive.Title className="sr-only">
						{title}
					</DialogPrimitive.Title>
					<Command {...props}>{children}</Command>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

export function CommandInput({ className, ...props }) {
	return (
		<div
			data-slot="command-input-wrapper"
			className="flex h-11 items-center gap-2 border-b border-border px-3"
		>
			<SearchIcon className="size-4 text-faint" />
			<CommandPrimitive.Input
				data-slot="command-input"
				className={cn(
					"h-full flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-faint",
					className,
				)}
				{...props}
			/>
		</div>
	);
}

export function CommandList({ className, ...props }) {
	return (
		<CommandPrimitive.List
			data-slot="command-list"
			className={cn("max-h-[360px] overflow-y-auto p-1", className)}
			{...props}
		/>
	);
}

export function CommandEmpty(props) {
	return (
		<CommandPrimitive.Empty
			data-slot="command-empty"
			className="py-8 text-center text-[13px] text-faint"
			{...props}
		/>
	);
}

export function CommandGroup({ className, ...props }) {
	return (
		<CommandPrimitive.Group
			data-slot="command-group"
			className={cn(
				"overflow-hidden p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-faint",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandItem({ className, ...props }) {
	return (
		<CommandPrimitive.Item
			data-slot="command-item"
			className={cn(
				"relative flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-[13px] outline-none select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent [&_svg]:size-4 [&_svg]:text-faint",
				className,
			)}
			{...props}
		/>
	);
}

export function CommandSeparator({ className, ...props }) {
	return (
		<CommandPrimitive.Separator
			data-slot="command-separator"
			className={cn("-mx-1 my-1 h-px bg-border", className)}
			{...props}
		/>
	);
}

export function CommandShortcut({ className, ...props }) {
	return (
		<span
			data-slot="command-shortcut"
			className={cn("ml-auto font-mono text-[11px] text-faint", className)}
			{...props}
		/>
	);
}
