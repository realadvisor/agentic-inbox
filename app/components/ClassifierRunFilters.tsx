import { Button, Popover, Select } from "@cloudflare/kumo";
import {
	CalendarBlankIcon,
	CaretDownIcon,
	EnvelopeSimpleIcon,
	FunnelSimpleIcon,
	TagIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useState, type ReactNode } from "react";

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
const dateField =
	"w-full min-w-0 rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-sm text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-brand";
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
	const [dateOpen, setDateOpen] = useState(false);
	const [from, setFrom] = useState(""),
		[to, setTo] = useState("");
	const appliedFrom = params.get("from") ?? "",
		appliedTo = params.get("to") ?? "";
	const dateLabel = (value: string) =>
		new Date(value + "T00:00:00Z").toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
			timeZone: "UTC",
		});
	const rangeLabel =
		appliedFrom && appliedTo
			? `${dateLabel(appliedFrom)} – ${dateLabel(appliedTo)}`
			: appliedFrom
				? `Since ${dateLabel(appliedFrom)}`
				: appliedTo
					? `Through ${dateLabel(appliedTo)}`
					: "All time";
	const narrowed = ["status", "classifier", "from", "to", "thread"].some(
		(key) => params.has(key),
	);
	function applyDates(start: string, end: string) {
		onChange({ from: start, to: end });
		setDateOpen(false);
	}
	function preset(days: number) {
		const end = new Date();
		const start = new Date(end);
		start.setUTCDate(start.getUTCDate() - days + 1);
		applyDates(
			start.toISOString().slice(0, 10),
			end.toISOString().slice(0, 10),
		);
	}
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
					<Popover
						open={dateOpen}
						onOpenChange={(open) => {
							setDateOpen(open);
							if (open) {
								setFrom(appliedFrom);
								setTo(appliedTo);
							}
						}}
					>
						<Popover.Trigger
							render={
								<Button
									variant="secondary"
									className="w-full justify-between font-normal"
									aria-label="Date range"
								/>
							}
						>
							<span className="flex min-w-0 items-center gap-2">
								<CalendarBlankIcon
									size={16}
									className="shrink-0 text-kumo-subtle"
								/>
								<span className="truncate">{rangeLabel}</span>
							</span>
							<CaretDownIcon size={14} className="shrink-0 text-kumo-subtle" />
						</Popover.Trigger>
						<Popover.Content
							align="end"
							className="w-80 max-w-[calc(100vw-24px)] rounded-xl p-4 shadow-lg"
						>
							<Popover.Title className="text-sm font-medium">
								Date range
							</Popover.Title>
							<div className="flex flex-wrap gap-2 my-4">
								<Button
									variant="secondary"
									size="sm"
									onClick={() => applyDates("", "")}
								>
									All time
								</Button>
								<Button variant="secondary" size="sm" onClick={() => preset(1)}>
									Today
								</Button>
								<Button variant="secondary" size="sm" onClick={() => preset(7)}>
									Last 7 days
								</Button>
								<Button
									variant="secondary"
									size="sm"
									onClick={() => preset(30)}
								>
									Last 30 days
								</Button>
							</div>
							<div className="grid grid-cols-2 gap-3 border-t border-kumo-line pt-4">
								<label className="text-xs text-kumo-subtle">
									From
									<input
										aria-label="From date"
										className={dateField + " mt-2"}
										type="date"
										value={from}
										max={to || undefined}
										onChange={(e) => setFrom(e.target.value)}
									/>
								</label>
								<label className="text-xs text-kumo-subtle">
									Through
									<input
										aria-label="Through date"
										className={dateField + " mt-2"}
										type="date"
										value={to}
										min={from || undefined}
										onChange={(e) => setTo(e.target.value)}
									/>
								</label>
							</div>
							<p className="text-xs text-kumo-subtle mt-3">
								Dates use UTC. Both days are included.
							</p>
							{from && to && from > to && (
								<p role="alert" className="text-xs text-kumo-danger mt-2">
									End date must be on or after the start date.
								</p>
							)}
							<div className="flex justify-end mt-4">
								<Button
									variant="primary"
									disabled={!!(from && to && from > to)}
									onClick={() => applyDates(from, to)}
								>
									Apply dates
								</Button>
							</div>
						</Popover.Content>
					</Popover>
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
