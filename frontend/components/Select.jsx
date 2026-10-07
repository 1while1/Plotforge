// Select 纸墨风下拉雏形（S3-1 D5，**不接线**）：受控原生 <select> 包装——React 受控
// value/onChange 天然等价原生行为；纸墨风＝全局 select 元素样式直接继承（styles/pages/workbench.css
// 对原生 select 的元素级样式），零新 CSS、零自定义浮层。
export default function Select({
	value,
	onChange,
	options,
	title,
	ariaLabel,
	disabled,
	className,
}) {
	return (
		<select
			value={value}
			onChange={(e) => {
				if (typeof onChange === "function") onChange(e.target.value);
			}}
			title={title}
			aria-label={ariaLabel}
			disabled={disabled}
			className={className}
		>
			{options.map((opt) => (
				<option key={opt.value} value={opt.value}>
					{opt.label}
				</option>
			))}
		</select>
	);
}
