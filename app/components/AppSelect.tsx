import { Select } from "@cloudflare/kumo";
import { useState } from "react";

/** Keep menus in the owning drawer's stacking and focus context. */
export function AppSelect({
	label,
	value,
	options,
	onChange,
	compact = false,
	inline = false,
	disabled = false,
	triggerClassName = "",
}: {
	label: string;
	value: string;
	options: { value: string; label: string; disabled?: boolean }[];
	onChange: (value: string) => void;
	compact?: boolean;
	inline?: boolean;
	disabled?: boolean;
	triggerClassName?: string;
}) {
	const [open, setOpen] = useState(false);
	const [container, setContainer] = useState<HTMLDivElement | null>(null);
	return (
		<div
			ref={setContainer}
			className={`relative min-w-0 ${compact || inline ? "" : "mt-1.5"} ${open ? "z-20" : ""}`}
		>
			<Select
				onOpenChange={setOpen}
				disabled={disabled}
				aria-label={label}
				value={value}
				items={options}
				container={container}
				size={compact ? "xs" : "base"}
				className={`${compact ? "" : "w-full"} ${triggerClassName}`}
				onValueChange={(value) => {
					if (value !== null) onChange(value);
				}}
			>
				{options.map((option) => (
					<Select.Option
						key={option.value}
						value={option.value}
						disabled={option.disabled}
					>
						{option.label}
					</Select.Option>
				))}
			</Select>
		</div>
	);
}
