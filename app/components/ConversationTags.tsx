import { Button, Input, Popover } from "@cloudflare/kumo";
import {
	RobotIcon,
	CheckIcon,
	CaretDownIcon,
	PlusIcon,
	TagIcon,
	XIcon,
	MagnifyingGlassIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTags, useTagMutation } from "~/queries/tags";
import api from "~/services/api";
import type { ConversationTag, Tag } from "~/types";

export function TagChips({
	tags = [],
	onRemove,
	disabled,
}: {
	tags?: (Tag & Partial<Pick<ConversationTag, "source">>)[];
	onRemove?: (id: string) => void;
	disabled?: boolean;
}) {
	return (
		<span className="inline-flex max-w-full flex-wrap gap-1.5">
			{tags.map((tag) => (
				<span
					key={tag.id}
					title={
						tag.source === "classifier"
							? "Applied automatically"
							: tag.source === "manual"
								? "Applied manually"
								: undefined
					}
					className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium text-kumo-default"
					style={{
						backgroundColor: `${tag.color}20`,
						color: `color-mix(in srgb, ${tag.color} 45%, currentColor)`,
						borderColor: `${tag.color}14`,
					}}
				>
					{tag.source === "classifier" && (
						<RobotIcon
							size={12}
							weight="fill"
							className="shrink-0"
							role="img"
							aria-label="Applied automatically"
						/>
					)}
					<span className="truncate" title={tag.name}>
						{tag.name}
					</span>
					{onRemove && (
						<button
							type="button"
							disabled={disabled}
							aria-label={`Remove tag ${tag.name}`}
							className="-mr-1 shrink-0 rounded p-0.5 text-kumo-subtle transition-colors hover:bg-kumo-fill hover:text-kumo-default focus-visible:outline-2 disabled:opacity-50"
							onClick={() => onRemove(tag.id)}
						>
							<XIcon size={12} />
						</button>
					)}
				</span>
			))}
		</span>
	);
}

export function TagPicker({
	tags,
	value,
	onChange,
	label,
	placeholder,
	disabled,
	allowAll = false,
}: {
	tags: Tag[];
	value?: string;
	onChange: (id: string) => void;
	label: string;
	placeholder: string;
	disabled?: boolean;
	allowAll?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const selected = tags.find((tag) => tag.id === value);
	const filtered = tags.filter((tag) =>
		tag.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
	);
	const choose = (id: string) => {
		onChange(id);
		setOpen(false);
	};
	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) setSearch("");
			}}
		>
			<Popover.Trigger
				render={
					<button
						type="button"
						disabled={disabled}
						aria-label={label}
						className={`inline-flex h-8 max-w-full items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-kumo-brand disabled:opacity-50 ${selected ? "border-kumo-line bg-kumo-tint text-kumo-default" : "border-transparent text-kumo-subtle hover:border-kumo-line hover:bg-kumo-tint hover:text-kumo-default"}`}
					/>
				}
			>
				{selected ? (
					<span
						className="h-2 w-2 rounded-full shrink-0"
						style={{ backgroundColor: selected.color }}
					/>
				) : allowAll ? (
					<TagIcon size={15} />
				) : (
					<PlusIcon size={14} />
				)}
				<span className="max-w-40 truncate">
					{selected?.name ?? (allowAll && value ? "Deleted tag" : placeholder)}
				</span>
				<CaretDownIcon size={12} className="shrink-0 text-kumo-subtle" />
			</Popover.Trigger>
			<Popover.Content
				align="start"
				className="w-64 max-w-[calc(100vw-24px)] overflow-hidden rounded-xl p-0 shadow-lg"
			>
				<Popover.Title className="px-3 pt-3 pb-2 text-xs font-medium text-kumo-subtle">
					{allowAll ? "Filter by tag" : "Choose a tag"}
				</Popover.Title>
				<div className="px-2 pb-2">
					<Input
						size="sm"
						aria-label="Search tags"
						placeholder="Search tags…"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
					/>
				</div>
				<div className="max-h-60 overflow-y-auto border-t border-kumo-line p-1.5">
					{allowAll && (
						<button
							type="button"
							className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-kumo-tint focus-visible:bg-kumo-tint"
							onClick={() => choose("")}
						>
							<TagIcon size={15} className="text-kumo-subtle" />
							<span className="flex-1">All conversations</span>
							{!value && <CheckIcon size={15} />}
						</button>
					)}
					{filtered.map((tag) => (
						<button
							type="button"
							key={tag.id}
							aria-label={`Choose tag ${tag.name}`}
							className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left hover:bg-kumo-tint focus-visible:bg-kumo-tint"
							onClick={() => choose(tag.id)}
						>
							<TagChips tags={[tag]} />
							{value === tag.id && (
								<CheckIcon size={15} className="shrink-0 text-kumo-subtle" />
							)}
						</button>
					))}
					{!filtered.length && (
						<div className="px-3 py-5 text-center text-xs text-kumo-subtle">
							<MagnifyingGlassIcon size={20} className="mx-auto mb-2" />
							{search ? "No matching tags" : "Create tags in Settings → Tags"}
						</div>
					)}
				</div>
			</Popover.Content>
		</Popover>
	);
}

export function TagActions({
	mailboxId,
	threadIds,
	tags,
	bulk = false,
}: {
	mailboxId: string;
	threadIds: string[];
	tags?: Tag[];
	bulk?: boolean;
}) {
	const catalog = useTags();
	const [selected, setSelected] = useState("");
	const mutation = useTagMutation(
		({ id, action }: { id: string; action: "add" | "remove" }) =>
			api.setConversationTags(mailboxId, threadIds, id, action),
	);
	const choices = (catalog.data ?? []).filter(
		(tag) => bulk || !tags?.some((assigned) => assigned.id === tag.id),
	);
	const validSelection = choices.some((tag) => tag.id === selected)
		? selected
		: "";
	const change = (id: string, action: "add" | "remove") =>
		mutation.mutate({ id, action });
	return (
		<div
			className="flex flex-wrap items-center gap-1.5 text-sm"
			aria-label={bulk ? "Bulk tags" : "Conversation tags"}
		>
			{!bulk && (
				<TagChips
					tags={tags}
					disabled={mutation.isPending}
					onRemove={(id) => change(id, "remove")}
				/>
			)}
			<TagPicker
				tags={choices}
				value={bulk ? validSelection : undefined}
				label={bulk ? "Tag for selected conversations" : "+ Tag"}
				placeholder={bulk ? "Choose tag" : "Add tag"}
				disabled={mutation.isPending || catalog.isPending || catalog.isError}
				onChange={(id) => (bulk ? setSelected(id) : change(id, "add"))}
			/>
			{bulk && (
				<>
					<Button
						size="sm"
						variant="secondary"
						disabled={
							!validSelection || mutation.isPending || !threadIds.length
						}
						onClick={() => change(validSelection, "add")}
					>
						Add tag
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={
							!validSelection || mutation.isPending || !threadIds.length
						}
						onClick={() => change(validSelection, "remove")}
					>
						Remove tag
					</Button>
				</>
			)}
			{(mutation.error || catalog.error) && (
				<p role="alert" className="text-xs text-kumo-danger">
					{(mutation.error || catalog.error)?.message}
				</p>
			)}
		</div>
	);
}
