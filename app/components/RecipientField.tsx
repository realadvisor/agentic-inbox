import { Input as KumoInput } from "@cloudflare/kumo";
import { type ReactNode, useRef, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { splitEmailList } from "~/lib/utils";

export default function RecipientField({
	label,
	value,
	onChange,
	action,
}: {
	action?: ReactNode;
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [input, setInput] = useState("");
	const [error, setError] = useState("");
	const addresses = splitEmailList(value);
	function add(text: string) {
		const incoming = splitEmailList(text.replaceAll(";", ","));
		if (
			incoming.some(
				(address) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address),
			)
		) {
			setError("Enter a valid email address.");
			inputRef.current?.setCustomValidity("Enter a valid email address.");
			return false;
		}
		onChange([...new Set([...addresses, ...incoming])].join(", "));
		setInput("");
		inputRef.current?.setCustomValidity("");
		setError("");
		return true;
	}
	return (
		<div className="flex items-start gap-2 px-4 py-1 border-b border-kumo-line/60">
			<label
				htmlFor={`recipient-${label}`}
				className="w-10 pt-1 shrink-0 text-xs text-kumo-subtle"
			>
				{label}
			</label>
			<div className="flex-1 min-w-0">
				<div className="flex flex-wrap items-center gap-1">
					{addresses.map((address) => (
						<span
							key={address}
							className="inline-flex max-w-full items-center gap-1 rounded-md border border-kumo-line/60 bg-kumo-tint/60 pl-2 pr-1 py-0.5 text-xs"
						>
							<span className="truncate">{address}</span>
							<button
								type="button"
								className="p-0.5 text-kumo-subtle hover:text-kumo-default"
								aria-label={`Remove ${address} from ${label}`}
								onClick={() =>
									onChange(addresses.filter((a) => a !== address).join(", "))
								}
							>
								<XIcon size={12} />
							</button>
						</span>
					))}
					<KumoInput
						ref={inputRef}
						id={`recipient-${label}`}
						aria-label={label}
						type="text"
						value={input}
						onChange={(event) => {
							setInput(event.target.value);
							event.target.setCustomValidity("");
							setError("");
						}}
						onBlur={() => {
							if (input.trim()) add(input);
						}}
						onKeyDown={(event) => {
							if (event.ctrlKey || event.metaKey) return;
							if (event.key === "Enter") event.preventDefault();
							if (
								["Enter", "Tab", ",", ";"].includes(event.key) &&
								input.trim()
							) {
								if (event.key !== "Tab") event.preventDefault();
								add(input);
							}
							if (event.key === "Backspace" && !input && addresses.length) {
								onChange(addresses.slice(0, -1).join(", "));
							}
						}}
						onPaste={(event) => {
							const text = event.clipboardData.getData("text");
							if (/[,;\n]/.test(text)) {
								event.preventDefault();
								add(text.replaceAll("\n", ","));
							}
						}}
						placeholder={addresses.length ? "Add…" : "Add an email address…"}
						className="min-w-20 w-20 flex-1 placeholder:text-kumo-inactive"
						aria-invalid={!!error}
					/>
				</div>
				{error && (
					<p role="alert" className="text-xs text-kumo-destructive">
						{error}
					</p>
				)}
			</div>
			{action && <div className="shrink-0 self-center">{action}</div>}
		</div>
	);
}
