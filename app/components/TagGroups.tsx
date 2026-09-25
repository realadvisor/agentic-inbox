import {
	decisionRules,
	scoreBoundaries,
	scoreRange,
} from "../../shared/decision-rules";
import {
	Input as KumoInput,
	Textarea as KumoTextarea,
	Checkbox as KumoCheckbox,
} from "@cloudflare/kumo";
import { DecisionRules } from "./DecisionRules";
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
	ChartBarIcon,
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
									{group.selection === "score"
										? "Ordered scale"
										: group.selection === "single"
											? "Choose one"
											: "Choose any"}
								</span>
							</div>
							{group.selection === "score" ? (
								<div
									className="flex flex-wrap items-center gap-x-1.5 gap-y-2"
									aria-label={`${group.name}: ordered scale from ${group.tags[0]?.name} to ${group.tags.at(-1)?.name}`}
								>
									{group.tags.map((tag, index) => {
										const edges = scoreBoundaries(
											group.tags.length,
											group.decision_rules,
										);
										const range =
											index === 0
												? `< ${edges[0]}`
												: index === group.tags.length - 1
													? `≥ ${edges[index - 1]}`
													: `${edges[index - 1]}–<${edges[index]}`;
										return (
											<span
												key={tag.id}
												className="inline-flex items-center gap-1.5"
												title={`${tag.name}: score ${scoreRange(index, group.tags.length, group.decision_rules)}. An exact boundary belongs to the higher level.`}
											>
												{index > 0 && (
													<CaretRightIcon
														size={12}
														className="shrink-0 text-kumo-subtle opacity-50"
														aria-hidden="true"
													/>
												)}
												<TagChips tags={[tag]} details={{ [tag.id]: range }} />
											</span>
										);
									})}
								</div>
							) : (
								<TagChips tags={group.tags} />
							)}
						</div>
						<span className="text-right text-xs text-kumo-subtle">
							{group.enabled ? "Automatic" : "Manual"}
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
	const [draft, updateDraft] = useState<TagGroupInput>(() =>
		current
			? {
					name: current.name,
					selection: current.selection,
					instructions: current.instructions,
					decision_rules: current.decision_rules,
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
	function setDraft(next: TagGroupInput) {
		if (
			next.tags.length !== draft.tags.length &&
			next.decision_rules?.score_boundaries
		)
			next = {
				...next,
				decision_rules: { ...next.decision_rules, score_boundaries: undefined },
			};
		updateDraft(next);
	}
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
						<div className="space-y-4">
							<Input
								label="Group name"
								autoFocus
								required
								maxLength={80}
								value={draft.name}
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							/>
							<fieldset>
								<legend className="mb-2 text-sm font-medium">Selection</legend>
								<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
									{(
										[
											{
												value: "single",
												label: "One tag",
												description: "Choose one matching tag.",
												icon: TagIcon,
											},
											{
												value: "multiple",
												label: "Multiple tags",
												description: "Apply any matching tags.",
												icon: StackIcon,
											},
											{
												value: "score",
												label: "Ordered scale",
												description: "Score from lowest to highest.",
												icon: ChartBarIcon,
											},
										] as const
									).map(({ value, label, description, icon: Icon }) => (
										<label key={value} className="relative cursor-pointer">
											<input
												type="radio"
												name="group-selection"
												value={value}
												checked={draft.selection === value}
												onChange={() =>
													setDraft({ ...draft, selection: value })
												}
												className="peer sr-only"
												aria-label={label}
											/>
											<span className="flex h-full gap-3 rounded-lg border border-kumo-line bg-kumo-base p-3 transition-colors hover:bg-kumo-tint peer-checked:border-blue-600 peer-checked:bg-blue-50/60 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-600 peer-disabled:cursor-not-allowed peer-disabled:opacity-50 sm:flex-col sm:gap-2 dark:peer-checked:bg-blue-950/30">
												<Icon
													size={20}
													weight={
														draft.selection === value ? "fill" : "regular"
													}
													className={
														draft.selection === value
															? "shrink-0 text-blue-600"
															: "shrink-0 text-kumo-subtle"
													}
													aria-hidden="true"
												/>
												<span>
													<span className="block text-sm font-medium">
														{label}
													</span>
													<span className="mt-1 block text-xs leading-relaxed text-kumo-subtle">
														{description}
													</span>
												</span>
											</span>
										</label>
									))}
								</div>
							</fieldset>
						</div>
						<div>
							<div className="mb-2 text-sm font-medium">
								{draft.selection === "score"
									? "Levels · lowest to highest"
									: "Tags"}
							</div>
							{draft.selection === "score" && (
								<p className="mb-3 text-xs text-kumo-subtle">
									Define 2–10 levels with clear descriptions. Jev scores the
									scale; uncertain results need review.
								</p>
							)}
							<div className="space-y-2">
								{draft.tags.map((tag, index) => (
									<div
										key={tag.id}
										className="flex w-full flex-wrap items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base p-2"
									>
										{draft.selection === "score" && (
											<div className="flex items-center gap-1 text-xs text-kumo-subtle">
												<span className="w-4 tabular-nums">{index}</span>
												{[-1, 1].map((delta) => (
													<button
														key={delta}
														type="button"
														aria-label={`Move ${tag.name} ${delta < 0 ? "down the scale" : "up the scale"}`}
														disabled={
															index + delta < 0 ||
															index + delta >= draft.tags.length
														}
														className="rounded px-1.5 py-1 hover:bg-kumo-tint disabled:opacity-30"
														onClick={() => {
															const tags = [...draft.tags];
															[tags[index], tags[index + delta]] = [
																tags[index + delta],
																tags[index],
															];
															setDraft({ ...draft, tags });
														}}
													>
														{delta < 0 ? "↑" : "↓"}
													</button>
												))}
											</div>
										)}
										<label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-kumo-subtle">
											<KumoInput
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
										<KumoInput
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
											className="min-w-0 flex-1"
										/>
										<button
											type="button"
											disabled={
												draft.selection === "score" && draft.tags.length <= 2
											}
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
										<KumoTextarea
											required={draft.selection === "score"}
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
											className="w-full resize-y leading-relaxed"
										/>
									</div>
								))}
							</div>
							<div className="mt-3 flex gap-2">
								<KumoInput
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
									className="min-w-0 flex-1"
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
							<div className="flex items-center gap-2 text-sm font-medium">
								<KumoCheckbox
									disabled={save.isPending || remove.isPending}
									checked={draft.enabled}
									onCheckedChange={(e) => setDraft({ ...draft, enabled: e })}
									label={<>Assign automatically with Jev</>}
								/>
							</div>
							{
								<label className="block text-sm font-medium">
									Instructions for Jev
									<KumoTextarea
										required={draft.enabled}
										maxLength={2000}
										rows={10}
										value={draft.instructions}
										onChange={(e) =>
											setDraft({ ...draft, instructions: e.target.value })
										}
										className="mt-2 block min-h-60 w-full resize-y font-normal leading-relaxed"
									/>
									<span className="mt-2 block text-xs font-normal text-kumo-subtle">
										Define each tag and when it applies. The request preview
										shows the full instructions sent for each tag.
									</span>
								</label>
							}
							{draft.selection === "score" ? (
								<section
									className="space-y-3 rounded-lg border border-kumo-line p-3"
									aria-label="Score boundaries"
								>
									<h3 className="text-sm font-medium">Score boundaries</h3>
									<p className="text-xs text-kumo-subtle">
										The numeric score selects a level. An exact boundary belongs
										to the higher level.
									</p>
									{draft.tags.map((tag, index) => (
										<div
											key={tag.id}
											className="flex items-center justify-between gap-3 text-sm"
										>
											<span>{tag.name}</span>
											{index === 0 ? (
												<span className="text-xs text-kumo-subtle">
													Starts at 0
												</span>
											) : (
												<label className="flex items-center gap-2 text-xs text-kumo-subtle">
													From
													<input
														aria-label={`${tag.name} starts at`}
														type="number"
														min={0.01}
														max={draft.tags.length - 1 - 0.01}
														step="any"
														required
														value={
															scoreBoundaries(
																draft.tags.length,
																draft.decision_rules,
															)[index - 1] ?? index - 0.5
														}
														onChange={(e) => {
															const edges = scoreBoundaries(
																draft.tags.length,
																draft.decision_rules,
															);
															edges[index - 1] = e.target.valueAsNumber;
															setDraft({
																...draft,
																decision_rules: {
																	...decisionRules(draft.decision_rules),
																	score_boundaries: edges,
																},
															});
														}}
														className="w-20 rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
													/>
												</label>
											)}
										</div>
									))}
									<label className="flex items-center justify-between gap-3 text-sm">
										Review below confidence
										<span className="flex items-center gap-1">
											<input
												aria-label="Review below confidence"
												type="number"
												min={0}
												max={100}
												required
												value={Math.round(
													decisionRules(draft.decision_rules).confidence * 100,
												)}
												onChange={(e) =>
													setDraft({
														...draft,
														decision_rules: {
															...decisionRules(draft.decision_rules),
															confidence: e.target.valueAsNumber / 100,
														},
													})
												}
												className="w-20 rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
											/>
											%
										</span>
									</label>
									<p className="text-xs text-kumo-subtle">
										Low-confidence scores remain visible and sortable, but their
										proposed level needs review before a tag is applied.
									</p>
									<button
										type="button"
										className="text-xs underline"
										onClick={() =>
											setDraft({
												...draft,
												decision_rules: {
													...decisionRules(draft.decision_rules),
													score_boundaries: undefined,
													confidence: 0.6,
												},
											})
										}
									>
										Restore midpoint boundaries and 60% confidence
									</button>
								</section>
							) : (
								<DecisionRules
									choice={draft.selection === "single"}
									value={draft.decision_rules}
									onChange={(decision_rules) =>
										setDraft({ ...draft, decision_rules })
									}
								/>
							)}
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
									JSON.stringify(draft.decision_rules) !==
										JSON.stringify(current.decision_rules) ||
									JSON.stringify(draft.tags) !==
										JSON.stringify(
											current.tags.map(({ id, name, color, description }) => ({
												id,
												name,
												color,
												description: description ?? "",
											})),
										)
								}
							/>
						</div>
					)}
				</section>
				<div className="min-w-0 space-y-4" aria-label="Test">
					<h3 className="text-sm font-semibold">Test</h3>
					<JevRequestPreview
						group={draft}
						groupId={current?.id}
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
