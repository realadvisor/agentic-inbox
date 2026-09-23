import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import { useTags, useTagMutation } from "~/queries/tags";
import api from "~/services/api";
import type { Tag } from "~/types";

export function TagChips({
	tags = [],
	onRemove,
	disabled,
}: {
	tags?: Tag[];
	onRemove?: (id: string) => void;
	disabled?: boolean;
}) {
	return (
		<span className="inline-flex max-w-full flex-wrap gap-1">
			{tags.map((tag) => (
				<span
					key={tag.id}
					className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs text-kumo-default bg-kumo-base"
					style={{ borderColor: tag.color }}
				>
					<span
						className="h-2 w-2 rounded-full shrink-0"
						style={{ backgroundColor: tag.color }}
					/>
					<span className="truncate" title={tag.name}>
						{tag.name}
					</span>
					{onRemove && (
						<button
							type="button"
							disabled={disabled}
							aria-label={`Remove tag ${tag.name}`}
							className="shrink-0 cursor-pointer px-1 disabled:opacity-50"
							onClick={() => onRemove(tag.id)}
						>
							×
						</button>
					)}
				</span>
			))}
		</span>
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
	const change = (id: string, action: "add" | "remove") => {
		if (!bulk) setSelected("");
		mutation.mutate({ id, action });
	};
	return (
		<div
			className="flex flex-wrap items-center gap-2 text-sm"
			aria-label={bulk ? "Bulk tags" : "Conversation tags"}
		>
			{!bulk && (
				<TagChips
					tags={tags}
					disabled={mutation.isPending}
					onRemove={(id) => change(id, "remove")}
				/>
			)}
			<select
				aria-label={bulk ? "Tag for selected conversations" : "+ Tag"}
				className="rounded-md border border-kumo-line bg-kumo-base p-1.5 max-w-48"
				value={validSelection}
				disabled={mutation.isPending || catalog.isPending || catalog.isError}
				onChange={(e) => setSelected(e.target.value)}
			>
				<option value="">{bulk ? "Choose tag" : "+ Tag"}</option>
				{choices.map((tag) => (
					<option key={tag.id} value={tag.id}>
						{tag.name}
					</option>
				))}
			</select>
			<Button
				size="sm"
				variant="secondary"
				disabled={!validSelection || mutation.isPending || !threadIds.length}
				onClick={() => change(validSelection, "add")}
			>
				{bulk ? "Add tag" : "Apply tag"}
			</Button>
			{bulk && (
				<Button
					size="sm"
					variant="secondary"
					disabled={!validSelection || mutation.isPending || !threadIds.length}
					onClick={() => change(validSelection, "remove")}
				>
					Remove tag
				</Button>
			)}
			{catalog.data?.length === 0 && (
				<span className="text-kumo-subtle">
					Create tags in Settings → Tags.
				</span>
			)}
			{(mutation.error || catalog.error) && (
				<p role="alert" className="text-kumo-danger">
					{(mutation.error || catalog.error)?.message}
				</p>
			)}
		</div>
	);
}
