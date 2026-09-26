import { Combobox } from "@cloudflare/kumo";
import { type ReactNode, useRef, useState } from "react";
import { XIcon } from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useRecipientSuggestions } from "~/queries/contacts";
import type { RecipientSuggestion } from "shared/contacts";
import { splitEmailList } from "~/lib/utils";

export default function RecipientField({
	label,
	value,
	onChange,
	action,
	excluded = [],
}: {
	excluded?: string[];
	action?: ReactNode;
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const [input, setInput] = useState("");
	const [error, setError] = useState("");
	const addresses = splitEmailList(value);
	const { mailboxId } = useParams();
	const { suggestions, unavailable } = useRecipientSuggestions(
		mailboxId,
		input,
		[...excluded, ...addresses],
	);
	const [open, setOpen] = useState(false);
	const [highlighted, setHighlighted] = useState<RecipientSuggestion>();
	function add(text: string) {
		const incoming = splitEmailList(text.replaceAll(";", ","));
		if (
			incoming.some(
				(address) => !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address),
			)
		) {
			setOpen(false);
			setError("Enter a valid email address.");
			inputRef.current?.setCustomValidity("Enter a valid email address.");
			return false;
		}
		onChange([...new Set([...addresses, ...incoming])].join(", "));
		setInput("");
		setOpen(false);
		setHighlighted(undefined);
		inputRef.current?.setCustomValidity("");
		setError("");
		return true;
	}
	return (
		<div className="flex items-start gap-2 px-4 min-h-9 py-1 border-b border-kumo-line/60">
			<label
				htmlFor={`recipient-${label}`}
				className="w-10 pt-1.5 shrink-0 text-xs text-kumo-subtle"
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
					<Combobox<RecipientSuggestion>
						items={suggestions}
						filter={null}
						value={null}
						inputValue={input}
						open={open && !error && (suggestions.length > 0 || unavailable)}
						onOpenChange={setOpen}
						onInputValueChange={setInput}
						onItemHighlighted={setHighlighted}
						itemToStringLabel={(item) => item.email}
						onValueChange={(item) => {
							if (item) add(item.email);
						}}
					>
						<Combobox.Input
							ref={inputRef}
							id={`recipient-${label}`}
							aria-label={label}
							type="text"
							onFocus={() => setOpen(true)}
							onChange={(event) => {
								setInput(event.target.value);
								setOpen(true);
								event.target.setCustomValidity("");
								setError("");
							}}
							onBlur={() => {
								setOpen(false);
								if (input.trim()) add(input);
							}}
							onKeyDown={(event) => {
								if (
									event.ctrlKey ||
									event.metaKey ||
									event.nativeEvent.isComposing
								)
									return;
								if (open && highlighted && suggestions.includes(highlighted)) {
									if (event.key === "Enter") return;
									if (event.key === "Tab") {
										event.preventDefault();
										add(highlighted.email);
										return;
									}
								}
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
							className="composer-header-input min-w-20 w-20 flex-1 placeholder:text-kumo-inactive"
							aria-invalid={!!error}
							aria-describedby={error ? `recipient-${label}-error` : undefined}
							onInvalid={(event) => {
								event.preventDefault();
								setError("Enter a valid email address.");
							}}
						/>
						<Combobox.Content align="start" className="recipient-suggestions">
							{unavailable && (
								<p role="status" className="px-3 py-2 text-xs text-kumo-subtle">
									Suggestions unavailable. You can still type an address.
								</p>
							)}
							<Combobox.List>
								{(item: RecipientSuggestion) => (
									<Combobox.Item key={item.email} value={item}>
										<div className="min-w-0 py-1">
											<div className="truncate text-sm">
												{item.name || item.email}
											</div>
											{item.name && (
												<div className="truncate text-xs text-kumo-subtle">
													{item.email}
												</div>
											)}
										</div>
									</Combobox.Item>
								)}
							</Combobox.List>
						</Combobox.Content>
					</Combobox>
				</div>
				{error && (
					<p
						id={`recipient-${label}-error`}
						role="alert"
						className="pb-1 pt-0.5 text-xs text-kumo-danger"
					>
						{error}
					</p>
				)}
			</div>
			{action && <div className="shrink-0 self-center">{action}</div>}
		</div>
	);
}
