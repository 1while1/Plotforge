import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "../../lib/cn.js";

export function TooltipProvider({ delayDuration = 300, ...props }) {
	return (
		<TooltipPrimitive.Provider
			data-slot="tooltip-provider"
			delayDuration={delayDuration}
			{...props}
		/>
	);
}

export const Tooltip = TooltipPrimitive.Root;

export function TooltipTrigger(props) {
	return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
	className,
	sideOffset = 6,
	children,
	...props
}) {
	return (
		<TooltipPrimitive.Portal>
			<TooltipPrimitive.Content
				data-slot="tooltip-content"
				sideOffset={sideOffset}
				className={cn(
					"z-[1100] max-w-64 rounded-md bg-[#111418] px-2.5 py-1.5 font-ui text-xs leading-snug text-white shadow-pop",
					className,
				)}
				{...props}
			>
				{children}
			</TooltipPrimitive.Content>
		</TooltipPrimitive.Portal>
	);
}
