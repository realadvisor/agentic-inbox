import { ExistingConversations, useTagClassifiers } from "./TagAutomation";
import { Button, Dialog, Input, Popover } from "@cloudflare/kumo";
import {
	PlusIcon,
	XIcon,
	CaretDownIcon,
	CaretRightIcon,
	TagIcon,
	StackIcon,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import {
	tagGroupInput,
	type TagGroup,
	type TagGroupInput,
} from "../../shared/tag-groups";
import { useTagMutation } from "~/queries/tags";
import api from "~/services/api";
import { useMailMode } from "./MailMode";
import { TagChips } from "./ConversationTags";

export function TagGroups({
	children,
	onNewTag,
}: {
	children: ReactNode;
	onNewTag: () => void;
}) {
	const [adding, setAdding] = useState(false);
	const catalog = useQuery({
		queryKey: ["tag-groups"],
		queryFn: api.listTagGroups,
	});
	const mode = useMailMode();
	const canEdit =
		!!mode.data &&
		(mode.data.mode !== "live" || !!mode.data.canManageClassifiers);
	const [editing, setEditing] = useState<TagGroup | null | undefined>();
	const [saving, setSaving] = useState(false);
	return (
		<section className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
			<header className="flex items-center justify-between gap-4 p-5">
				<div className="flex min-w-0 items-center gap-3">
					<div className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle sm:flex">
						<TagIcon size={21} />
					</div>
					<div>
						<h2 className="text-sm font-semibold">Tags</h2>
						<p className="mt-1 text-xs text-kumo-subtle">
							Organize conversations with tags and groups.
						</p>
					</div>
				</div>
				<Popover open={adding} onOpenChange={setAdding}>
					<Popover.Trigger
						render={
							<Button
								size="sm"
								variant="primary"
								icon={<PlusIcon size={14} />}
								aria-label="Add tag or group"
							/>
						}
					>
						Add <CaretDownIcon size={12} />
					</Popover.Trigger>
					<Popover.Content
						align="end"
						className="w-64 rounded-lg border border-kumo-line bg-kumo-base p-1 shadow-lg"
					>
						<Popover.Title className="sr-only">Add tag or group</Popover.Title>
						<button
							type="button"
							className="flex w-full items-start gap-3 rounded-md p-3 text-left hover:bg-kumo-tint"
							onClick={() => {
								setAdding(false);
								onNewTag();
							}}
						>
							<TagIcon size={18} className="mt-0.5 shrink-0 text-kumo-subtle" />
							<span>
								<span className="block text-sm font-medium">Tag</span>
								<span className="block text-xs text-kumo-subtle">
									A label you can use on its own
								</span>
							</span>
						</button>
						<button
							type="button"
							disabled={!canEdit}
							className="flex w-full items-start gap-3 rounded-md p-3 text-left hover:bg-kumo-tint disabled:opacity-50"
							onClick={() => {
								setAdding(false);
								setEditing(null);
							}}
						>
							<StackIcon
								size={18}
								className="mt-0.5 shrink-0 text-kumo-subtle"
							/>
							<span>
								<span className="block text-sm font-medium">Group</span>
								<span className="block text-xs text-kumo-subtle">
									Related tags, like Low, Medium, High
								</span>
							</span>
						</button>
					</Popover.Content>
				</Popover>
			</header>
			<div className="divide-y divide-kumo-line border-y border-kumo-line">
				{catalog.data?.map((group) => (
					<button
						type="button"
						key={group.id}
						className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-kumo-tint disabled:cursor-default"
						disabled={!canEdit}
						aria-label={`Edit ${group.name} group`}
						onClick={() => setEditing(group)}
					>
						<div className="min-w-0 flex-1">
							<div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
								<span className="text-sm font-medium">{group.name}</span>
								<span className="text-xs text-kumo-subtle">
									{group.selection === "single" ? "Choose one" : "Choose any"}
								</span>
							</div>
							<TagChips tags={group.tags} />
						</div>
						<span className="text-xs text-kumo-subtle">
							{group.enabled ? "Jev" : "Manual"}
						</span>
						<CaretRightIcon size={16} className="shrink-0 text-kumo-subtle" />
					</button>
				))}
				{children}
			</div>
			{catalog.isPending && (
				<p className="px-5 py-4 text-sm text-kumo-subtle">Loading groups…</p>
			)}
			{catalog.error && (
				<p role="alert" className="px-5 py-4 text-sm text-kumo-danger">
					{catalog.error.message}{" "}
					<button onClick={() => catalog.refetch()}>Retry</button>
				</p>
			)}
			<p className="bg-kumo-tint px-5 py-3 text-xs leading-relaxed text-kumo-subtle">
				Shared across all mailboxes. Click any row to edit tags and automatic
				assignment.
			</p>
			<Dialog.Root
				open={editing !== undefined}
				onOpenChange={(open) => {
					if (!open && !saving) setEditing(undefined);
				}}
			>
				<Dialog size="base" className="max-h-[90dvh] overflow-y-auto p-6">
					{editing !== undefined && (
						<Editor
							key={editing?.id ?? "new"}
							current={editing}
							onSaving={setSaving}
							close={() => setEditing(undefined)}
						/>
					)}
				</Dialog>
			</Dialog.Root>
		</section>
	);
}

function Editor({
	current,
	close,
	onSaving,
}: {
	current: TagGroup | null;
	close: () => void;
	onSaving: (saving: boolean) => void;
}) {
	const [draft, setDraft] = useState<TagGroupInput>(() =>
		current
			? {
					name: current.name,
					selection: current.selection,
					instructions: current.instructions,
					enabled: current.enabled,
					revision: current.revision,
					tags: current.tags.map(({ id, name, color }) => ({
						id,
						name,
						color,
					})),
				}
			: {
					name: "",
					selection: "single",
					instructions: "",
					enabled: false,
					tags: [],
				},
	);
	const classifiers = useTagClassifiers();
	const [newTag, setNewTag] = useState("");
	const [error, setError] = useState("");
	const save = useTagMutation((data: TagGroupInput) =>
		current ? api.updateTagGroup(current.id, data) : api.createTagGroup(data),
	);
	function add() {
		const name = newTag.trim();
		if (!name) return;
		if (
			draft.tags.some((t) => t.name.trim().toLowerCase() === name.toLowerCase())
		) {
			setError("This tag already exists in the group.");
			return;
		}
		setDraft({
			...draft,
			tags: [
				...draft.tags,
				{ id: crypto.randomUUID(), name, color: "#2563eb" },
			],
		});
		setNewTag("");
		setError("");
	}
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (save.isPending) return;
				if (newTag.trim()) {
					setError("Add the new tag before saving.");
					return;
				}
				const result = tagGroupInput.safeParse(draft);
				if (!result.success) {
					setError(result.error.issues[0].message);
					return;
				}
				setError("");
				onSaving(true);
				save.mutate(result.data, {
					onSuccess: close,
					onSettled: () => onSaving(false),
				});
			}}
		>
			<Dialog.Title className="mb-5 text-base font-semibold">
				{current ? `Edit ${current.name}` : "New tag group"}
			</Dialog.Title>
			<fieldset disabled={save.isPending} className="space-y-5">
				<Input
					label="Group name"
					required
					maxLength={80}
					value={draft.name}
					onChange={(e) => setDraft({ ...draft, name: e.target.value })}
				/>
				<label className="block text-sm font-medium">
					Selection
					<select
						aria-label="Selection"
						value={draft.selection}
						onChange={(e) =>
							setDraft({
								...draft,
								selection: e.target.value === "single" ? "single" : "multiple",
							})
						}
						className="mt-2 block w-full rounded-md border border-kumo-line bg-kumo-base p-2"
					>
						<option value="single">One tag</option>
						<option value="multiple">Multiple tags</option>
					</select>
				</label>
				<div>
					<div className="mb-2 text-sm font-medium">Tags</div>
					<div className="flex flex-wrap gap-2">
						{draft.tags.map((tag, index) => (
							<div
								key={tag.id}
								className="flex max-w-full items-center gap-1 rounded-md bg-kumo-fill px-2 py-1"
							>
								<input
									aria-label={`Tag ${index + 1} name`}
									required
									maxLength={80}
									value={tag.name}
									onChange={(e) =>
										setDraft({
											...draft,
											tags: draft.tags.map((t) =>
												t.id === tag.id ? { ...t, name: e.target.value } : t,
											),
										})
									}
									style={{
										width: `${Math.min(22, Math.max(5, tag.name.length + 1))}ch`,
									}}
									className="min-w-0 bg-transparent text-sm"
								/>
								<button
									type="button"
									aria-label={`Remove ${tag.name} tag`}
									className="rounded p-1 text-kumo-subtle"
									onClick={() =>
										setDraft({
											...draft,
											tags: draft.tags.filter((t) => t.id !== tag.id),
										})
									}
								>
									<XIcon size={14} />
								</button>
							</div>
						))}
					</div>
					<div className="mt-3 flex gap-2">
						<input
							aria-label="New tag name"
							placeholder="Add a tag…"
							maxLength={80}
							value={newTag}
							disabled={draft.tags.length >= 10}
							onChange={(e) => setNewTag(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									if (draft.tags.length < 10) add();
								}
							}}
							className="min-w-0 flex-1 rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
						/>
						<Button
							type="button"
							variant="secondary"
							disabled={!newTag.trim() || draft.tags.length >= 10}
							onClick={add}
						>
							Add
						</Button>
					</div>
				</div>
				<div className="space-y-4 border-t border-kumo-line pt-4">
					<label className="flex items-center gap-2 text-sm font-medium">
						<input
							type="checkbox"
							checked={draft.enabled}
							onChange={(e) =>
								setDraft({ ...draft, enabled: e.target.checked })
							}
						/>
						Assign automatically with Jev
					</label>
					{draft.enabled && (
						<label className="block text-sm font-medium">
							Instructions for Jev
							<textarea
								required
								maxLength={2000}
								rows={4}
								value={draft.instructions}
								onChange={(e) =>
									setDraft({ ...draft, instructions: e.target.value })
								}
								className="mt-2 block w-full resize-y rounded-md border border-kumo-line bg-kumo-base p-3 text-sm font-normal"
							/>
							<span className="mt-2 block text-xs font-normal text-kumo-subtle">
								Explain how Jev should choose between this group’s tags.
							</span>
						</label>
					)}
					<p className="text-xs text-kumo-subtle">
						Saving does not process existing conversations. Manual choices stay.
					</p>
				</div>
			</fieldset>
			{current && classifiers.canManage && (
				<div className="mt-4">
					<ExistingConversations
						classifiers={
							classifiers.data?.filter((c) => c.group_id === current.id) ?? []
						}
						disabled={
							save.isPending ||
							newTag.trim().length > 0 ||
							draft.name !== current.name ||
							draft.selection !== current.selection ||
							draft.instructions !== current.instructions ||
							draft.enabled !== current.enabled ||
							JSON.stringify(draft.tags) !== JSON.stringify(current.tags)
						}
					/>
				</div>
			)}

			{(error || save.error) && (
				<p role="alert" className="mt-4 text-sm text-kumo-danger">
					{error || save.error?.message}
				</p>
			)}
			<div className="mt-6 flex justify-end gap-2">
				<Button
					type="button"
					variant="secondary"
					disabled={save.isPending}
					onClick={close}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					variant="primary"
					loading={save.isPending}
					disabled={save.isPending}
				>
					Save group
				</Button>
			</div>
		</form>
	);
}
