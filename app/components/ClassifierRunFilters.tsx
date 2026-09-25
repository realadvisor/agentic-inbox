import { DateRangeField } from "./DateRangeField";
import { Button, Select } from "@cloudflare/kumo";
import {
	EnvelopeSimpleIcon,
	FunnelSimpleIcon,
	TagIcon,
	XIcon,
} from "@phosphor-icons/react";
import { type ReactNode } from "react";

interface Choice {
	value: string;
	label: string;
}
const statusChoices = [
	{ value: "queued", label: "Queued" },
	{ value: "blocked", label: "Blocked before sending" },
	{ value: "review", label: "Needs review" },
	{ value: "skipped", label: "Skipped" },
	{ value: "all", label: "All statuses" },
	{ value: "succeeded", label: "Succeeded" },
	{ value: "failed", label: "Failed" },
	{ value: "running", label: "Running" },
	{ value: "interrupted", label: "Interrupted" },
];
function FilterSelect({
	label,
	value,
	choices,
	icon,
	onChange,
}: {
	label: string;
	value: string;
	choices: Choice[];
	icon: ReactNode;
	onChange: (value: string) => void;
}) {
	return (
		<div
			className={
				label === "Mailbox" ? "min-w-0 col-span-2 sm:col-span-1" : "min-w-0"
			}
		>
			<span className="block text-xs font-medium text-kumo-subtle mb-2">
				{label}
			</span>
			<Select
				aria-label={label}
				value={value}
				items={choices}
				className="w-full min-w-0"
				onValueChange={(value) => {
					if (value) onChange(value);
				}}
				renderValue={(value) => (
					<span className="flex min-w-0 items-center gap-2">
						<span className="shrink-0 text-kumo-subtle">{icon}</span>
						<span className="truncate">
							{choices.find((c) => c.value === value)?.label ?? value}
						</span>
					</span>
				)}
			>
				{choices.map((c) => (
					<Select.Option key={c.value} value={c.value}>
						{c.label}
					</Select.Option>
				))}
			</Select>
		</div>
	);
}
export function ClassifierRunFilters({
	mailbox,
	mailboxes,
	classifiers,
	params,
	onChange,
}: {
	mailbox: string;
	mailboxes: Choice[];
	classifiers: Choice[];
	params: URLSearchParams;
	onChange: (changes: Record<string, string>) => void;
}) {
	const narrowed = ["status", "classifier", "from", "to", "thread"].some(
		(key) => params.has(key),
	);
	return (
		<div
			className="mt-5 border-t border-kumo-line pt-4"
			aria-label="Classifier run filters"
		>
			<div className="grid grid-cols-2 xl:grid-cols-[minmax(180px,1.4fr)_minmax(140px,1fr)_minmax(160px,1.1fr)_minmax(185px,1.3fr)] gap-x-3 gap-y-4">
				<FilterSelect
					label="Mailbox"
					value={mailbox}
					choices={[{ value: "all", label: "All mailboxes" }, ...mailboxes]}
					icon={<EnvelopeSimpleIcon size={16} />}
					onChange={(value) => onChange({ mailbox: value })}
				/>
				<FilterSelect
					label="Status"
					value={params.get("status") ?? "all"}
					choices={statusChoices}
					icon={<FunnelSimpleIcon size={16} />}
					onChange={(value) =>
						onChange({ status: value === "all" ? "" : value })
					}
				/>
				<FilterSelect
					label="Classifier"
					value={params.get("classifier") ?? "all"}
					choices={[{ value: "all", label: "All classifiers" }, ...classifiers]}
					icon={<TagIcon size={16} />}
					onChange={(value) =>
						onChange({ classifier: value === "all" ? "" : value })
					}
				/>
				<div className="min-w-0 col-span-2 sm:col-span-1">
					<span className="block text-xs font-medium text-kumo-subtle mb-2">
						Date range
					</span>
					<DateRangeField
						from={params.get("from") ?? ""}
						to={params.get("to") ?? ""}
						utc
						onChange={(from, to) => onChange({ from, to })}
					/>
				</div>
			</div>
			{narrowed && (
				<div className="flex flex-wrap items-center gap-2 mt-3">
					{params.has("thread") && (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => onChange({ thread: "" })}
						>
							Conversation filter <XIcon size={12} />
						</Button>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={() =>
							onChange({
								status: "",
								classifier: "",
								from: "",
								to: "",
								thread: "",
							})
						}
					>
						Clear filters
					</Button>
				</div>
			)}
		</div>
	);
}
