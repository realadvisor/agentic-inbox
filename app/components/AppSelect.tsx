import { Select } from "@cloudflare/kumo";
import { useState } from "react";

/** Keep menus in the owning drawer's stacking and focus context. */
export function AppSelect({
	label,
	value,
	options,
	onChange,
	compact = false,
	disabled = false,
}: {
	label: string;
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	compact?: boolean;
	disabled?: boolean;
}) {
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	return (
		<div ref={setContainer} className={compact ? "min-w-0" : "mt-1.5 min-w-0"}>
			<Select
				disabled={disabled}
				aria-label={label}
				value={value}
				items={options}
				container={container}
				size={compact ? "xs" : "base"}
				className={compact ? "" : "w-full"}
				onValueChange={(value) => {
					if (value !== null) onChange(value);
				}}
			>
				{options.map((option) => (
					<Select.Option key={option.value} value={option.value}>
						{option.label}
					</Select.Option>
				))}
			</Select>
		</div>
	);
}
