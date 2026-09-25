import { Button, DatePicker, Popover } from "@cloudflare/kumo";
import { CalendarBlankIcon, CaretDownIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

function date(value: string) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
	const parsed = new Date(value + "T00:00:00");
	return day(parsed) === value ? parsed : undefined;
}
function day(value: Date | undefined) {
	return value && !Number.isNaN(value.getTime())
		? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`
		: "";
}
function rangeLabel(from: string, to: string) {
	const format = (value: string) =>
		date(value)?.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	return from && to
		? `${format(from)} – ${format(to)}`
		: from
			? `Since ${format(from)}`
			: to
				? `Through ${format(to)}`
				: "All time";
}

// Kumo's DatePicker + Popover + presets composition, shared by filters and reruns.
export function DateRangeField({
	from,
	to,
	onChange,
	disabled = false,
	utc = false,
}: {
	from: string;
	to: string;
	onChange: (from: string, to: string) => void;
	disabled?: boolean;
	utc?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [start, setStart] = useState(from);
	const [end, setEnd] = useState(to);
	const [month, setMonth] = useState(new Date());
	const [wide, setWide] = useState(false);
	useEffect(() => {
		const query = window.matchMedia("(min-width: 48rem)");
		const update = () => setWide(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	function choose(first: string, last: string) {
		setStart(first);
		setEnd(last);
		setMonth(date(first) ?? new Date());
	}
	function preset(days: number) {
		const today = new Date();
		const last = utc ? today.toISOString().slice(0, 10) : day(today);
		const first = date(last)!;
		first.setDate(first.getDate() - days + 1);
		choose(day(first), last);
	}
	return (
		<div className="min-w-0">
			<Popover
				open={open && !disabled}
				onOpenChange={(next) => {
					setOpen(next);
					if (next) choose(from, to);
				}}
			>
				<Popover.Trigger
					render={
						<Button
							type="button"
							disabled={disabled}
							variant="secondary"
							aria-label="Date range"
							className="w-full justify-between font-normal"
						/>
					}
				>
					<span className="flex min-w-0 items-center gap-2">
						<CalendarBlankIcon
							size={16}
							className="shrink-0 text-kumo-subtle"
						/>
						<span className="truncate">{rangeLabel(from, to)}</span>
					</span>
					<CaretDownIcon size={14} className="shrink-0 text-kumo-subtle" />
				</Popover.Trigger>
				<Popover.Content
					positionMethod="fixed"
					align="start"
					className="date-range-popup w-max max-w-[calc(100vw-24px)] max-h-[min(85dvh,var(--available-height))] p-0"
				>
					<Popover.Title className="sr-only">Choose date range</Popover.Title>
					<div className="flex min-h-0 flex-col overflow-y-auto md:flex-row">
						<div className="flex flex-wrap gap-1 border-b border-kumo-line p-2 md:flex-col md:border-b-0 md:border-r">
							<Button
								type="button"
								variant={!start && !end ? "secondary" : "ghost"}
								size="sm"
								onClick={() => choose("", "")}
							>
								All time
							</Button>
							{[1, 7, 30, 90].map((days) => (
								<Button
									key={days}
									type="button"
									variant="ghost"
									size="sm"
									className="justify-start"
									onClick={() => preset(days)}
								>
									{days === 1 ? "Today" : `Last ${days} days`}
								</Button>
							))}
						</div>
						<div className="p-3 space-y-3">
							<div aria-label="Date range calendar">
								<DatePicker
									mode="range"
									numberOfMonths={wide ? 2 : 1}
									styles={{
										months: { flexWrap: "nowrap" },
										month: { flexShrink: 0 },
									}}
									month={month}
									onMonthChange={setMonth}
									selected={
										date(start)
											? { from: date(start), to: date(end) }
											: undefined
									}
									onChange={(range) => {
										setStart(day(range?.from));
										setEnd(day(range?.to));
									}}
								/>
							</div>
							<p className="text-xs text-kumo-subtle">
								{rangeLabel(start, end)} · {utc ? "UTC" : "Local time"}
							</p>
						</div>
					</div>
					<div className="flex shrink-0 justify-end gap-2 border-t border-kumo-line p-3">
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							Cancel
						</Button>
						<Button
							type="button"
							variant="primary"
							onClick={() => {
								onChange(start, end);
								setOpen(false);
							}}
						>
							Apply dates
						</Button>
					</div>
				</Popover.Content>
			</Popover>
		</div>
	);
}
