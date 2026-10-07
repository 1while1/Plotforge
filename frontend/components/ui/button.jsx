import { cva } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "../../lib/cn.js";

export const buttonVariants = cva(
	"inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-ui text-[13px] leading-none transition-colors outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
	{
		variants: {
			variant: {
				primary:
					"bg-primary font-semibold text-primary-foreground hover:bg-primary-hover",
				outline:
					"border border-border-strong bg-surface text-foreground hover:border-faint hover:bg-accent",
				ghost: "text-subtle hover:bg-accent hover:text-foreground",
				soft: "bg-primary-soft text-primary hover:brightness-95",
				destructive:
					"text-destructive hover:bg-destructive/10 hover:text-destructive",
			},
			size: {
				sm: "h-7 px-2.5 text-xs",
				md: "h-8 px-3",
				lg: "h-9 px-4 text-sm",
				icon: "size-8",
				"icon-sm": "size-7 [&_svg]:size-3.5",
			},
		},
		defaultVariants: { variant: "ghost", size: "md" },
	},
);

export function Button({
	className,
	variant,
	size,
	asChild = false,
	type = "button",
	...props
}) {
	const Comp = asChild ? Slot.Root : "button";
	return (
		<Comp
			data-slot="button"
			type={asChild ? undefined : type}
			className={cn(buttonVariants({ variant, size }), className)}
			{...props}
		/>
	);
}
