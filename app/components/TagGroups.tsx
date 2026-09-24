import { JevRequestPreview } from "./JevRequestPreview";
import { groupQuestion } from "../../shared/tag-groups";
import { ExistingConversations, useTagClassifiers } from "./TagAutomation";
import { Button, Dialog, Input, Popover } from "@cloudflare/kumo";
import {
	TrashIcon,
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
						className="grid w-full grid-cols-[minmax(0,1fr)_3rem_1rem] items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-kumo-tint disabled:cursor-default"
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
						<span className="text-right text-xs text-kumo-subtle">
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
				<Dialog
					size="base"
					style={{
						top: 0,
						left: "auto",
						right: 0,
						bottom: 0,
						margin: 0,
						transform: "none",
						translate: "none",
						scale: "none",
						borderRadius: 0,
						height: "100dvh",
						maxWidth: "none",
						zIndex: 100,
					}}
					className="flex w-full flex-col overflow-hidden border-l border-kumo-line p-5 shadow-2xl md:w-[90vw] md:p-8"
				>
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
					tags: current.tags.map(({ id, name, color, description }) => ({
						id,
						name,
						color,
						description: description ?? "",
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
	const remove = useTagMutation(api.deleteTagGroup);
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
				{ id: crypto.randomUUID(), name, color: "#2563eb", description: "" },
			],
		});
		setNewTag("");
		setError("");
	}
	return (
		<form
			className="flex min-h-0 flex-1 flex-col"
			onSubmit={(e) => {
				e.preventDefault();
				if (save.isPending || remove.isPending) return;
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
			<Dialog.Title className="mb-6 shrink-0 text-xl font-semibold">
				{current ? `Edit ${current.name}` : "New tag group"}
			</Dialog.Title>
			<div className="-mx-1 grid min-h-0 flex-1 grid-cols-1 items-start gap-6 overflow-y-auto px-1 py-1 lg:grid-cols-2">
				<section aria-label="Configure" className="min-w-0 space-y-5">
					<h3 className="text-sm font-semibold">Configure</h3>
					<fieldset
						disabled={save.isPending || remove.isPending}
						className="min-w-0 space-y-5"
					>
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<Input
								label="Group name"
								autoFocus
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
											selection:
												e.target.value === "single" ? "single" : "multiple",
										})
									}
									className="mt-2 block w-full rounded-md border border-kumo-line bg-kumo-base p-2"
								>
									<option value="single">One tag</option>
									<option value="multiple">Multiple tags</option>
								</select>
							</label>
						</div>
						<div>
							<div className="mb-2 text-sm font-medium">Tags</div>
							<div className="space-y-2">
								{draft.tags.map((tag, index) => (
									<div
										key={tag.id}
										className="flex w-full flex-wrap items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base p-2"
									>
										<label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-kumo-subtle">
											<input
												type="color"
												aria-label={`Tag ${index + 1} color`}
												value={tag.color}
												onChange={(e) =>
													setDraft({
														...draft,
														tags: draft.tags.map((t) =>
															t.id === tag.id
																? { ...t, color: e.target.value }
																: t,
														),
													})
												}
												className="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
											/>
											<span className="sr-only">Color</span>
										</label>
										<input
											aria-label={`Tag ${index + 1} name`}
											required
											maxLength={80}
											value={tag.name}
											onChange={(e) =>
												setDraft({
													...draft,
													tags: draft.tags.map((t) =>
														t.id === tag.id
															? { ...t, name: e.target.value }
															: t,
													),
												})
											}
											style={{
												width: `${Math.min(22, Math.max(5, tag.name.length + 1))}ch`,
											}}
											className="min-w-0 flex-1 bg-transparent text-sm"
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
											<XIcon size={16} />
										</button>
										<textarea
											aria-label={`Tag ${index + 1} description`}
											placeholder="When should this tag apply? Include important exceptions."
											value={tag.description}
											maxLength={1000}
											rows={2}
											onChange={(e) =>
												setDraft({
													...draft,
													tags: draft.tags.map((t) =>
														t.id === tag.id
															? { ...t, description: e.target.value }
															: t,
													),
												})
											}
											className="w-full resize-y rounded border border-kumo-line bg-kumo-base p-2 text-xs leading-relaxed"
										/>
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
							{
								<label className="block text-sm font-medium">
									Instructions for Jev
									<textarea
										required={draft.enabled}
										maxLength={2000}
										rows={10}
										value={draft.instructions}
										onChange={(e) =>
											setDraft({ ...draft, instructions: e.target.value })
										}
										className="mt-2 block min-h-60 w-full resize-y rounded-lg border border-kumo-line bg-kumo-base p-4 text-sm font-normal leading-relaxed"
									/>
									<span className="mt-2 block text-xs font-normal text-kumo-subtle">
										Define each tag and when it applies. The request preview
										shows the full instructions sent for each tag.
									</span>
								</label>
							}
							<p className="text-xs text-kumo-subtle">
								Saving does not process existing conversations. Manual choices
								stay.
							</p>
						</div>
					</fieldset>

					{current && classifiers.canManage && (
						<div className="min-w-0">
							<ExistingConversations
								classifiers={
									classifiers.data?.filter((c) => c.group_id === current.id) ??
									[]
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
				</section>
				<div className="min-w-0 space-y-4" aria-label="Test">
					<h3 className="text-sm font-semibold">Test</h3>
					<JevRequestPreview
						group={draft}
						selection={draft.selection}
						questions={draft.tags.map((tag) => ({
							name: tag.name,
							question: groupQuestion(draft, tag),
						}))}
					/>
				</div>
				{(error || save.error || remove.error) && (
					<p role="alert" className="text-sm text-kumo-danger lg:col-span-2">
						{error || save.error?.message || remove.error?.message}
					</p>
				)}
			</div>
			<div className="mt-4 flex shrink-0 justify-end gap-2 border-t border-kumo-line bg-kumo-base pt-4">
				{current && (
					<Button
						type="button"
						variant="ghost"
						className="mr-auto text-kumo-danger"
						disabled={save.isPending || remove.isPending}
						onClick={() => {
							if (
								!window.confirm(
									`Delete “${current.name}” and all its tags from every mailbox and conversation? Automatic assignment will stop. Past run records will be retained.`,
								)
							)
								return;
							onSaving(true);
							remove.mutate(current, {
								onSuccess: close,
								onSettled: () => onSaving(false),
							});
						}}
					>
						<TrashIcon size={16} />
						Delete group
					</Button>
				)}
				<Button
					type="button"
					variant="secondary"
					disabled={save.isPending || remove.isPending}
					onClick={close}
				>
					Cancel
				</Button>
				<Button
					type="submit"
					variant="primary"
					loading={save.isPending}
					disabled={save.isPending || remove.isPending}
				>
					Save group
				</Button>
			</div>
		</form>
	);
}
