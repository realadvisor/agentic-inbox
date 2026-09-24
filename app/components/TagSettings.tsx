import {
	AutomationFields,
	ExistingConversations,
	automationDraft,
	useTagClassifiers,
} from "./TagAutomation";
import { classifierRequest, type Classifier } from "~/services/classifiers";
import { Button, Dialog, Input } from "@cloudflare/kumo";
import { TrashIcon, CheckIcon } from "@phosphor-icons/react";
import { useState, useRef } from "react";
import { useTags, useTagMutation } from "~/queries/tags";
import api from "~/services/api";
import type { Tag } from "~/types";
import { TagChips } from "./ConversationTags";
import { TagGroups } from "./TagGroups";

const COLORS = [
	["Blue", "#2563eb"],
	["Violet", "#7c3aed"],
	["Pink", "#db2777"],
	["Red", "#dc2626"],
	["Orange", "#ea580c"],
	["Amber", "#ca8a04"],
	["Green", "#16a34a"],
	["Teal", "#0d9488"],
	["Slate", "#64748b"],
];

export function TagSettings() {
	const catalog = useTags();
	const [editing, setEditing] = useState<Tag | null | undefined>(undefined);
	const [name, setName] = useState("");
	const [color, setColor] = useState("#2563eb");
	const classifiers = useTagClassifiers();
	const [classifier, setClassifier] = useState<Classifier | undefined>();
	const [automation, setAutomation] = useState(automationDraft());
	const [automationValid, setAutomationValid] = useState(true);
	const persistedTag = useRef<Tag | null>(null);
	const save = useTagMutation(async () => {
		if (!automationValid) throw new Error("Select at least one mailbox.");
		if (classifiers.available && (classifiers.isPending || classifiers.error))
			throw new Error("Wait for the saved Jev settings to load before saving.");
		const target = persistedTag.current ?? editing;
		const tag = target
			? await api.updateTag(target.id, { name, color })
			: await api.createTag({ name, color });
		persistedTag.current = tag;
		const changed =
			JSON.stringify(automation) !==
			JSON.stringify(automationDraft(classifier));
		if (
			classifiers.canManage &&
			changed &&
			(classifier || automation.enabled)
		) {
			try {
				const saved = await classifierRequest<Classifier>(
					"/classifiers" + (classifier ? "/" + classifier.id : ""),
					classifier ? "PUT" : "POST",
					{
						...automation,
						question: automation.question.trim() || classifier?.question,
						tag_id: tag.id,
						revision: classifier?.revision,
					},
				);
				setClassifier(saved);
			} catch (error) {
				throw new Error(
					`Tag details saved, but Jev settings could not be saved: ${error instanceof Error ? error.message : "Please retry."}`,
				);
			}
		}
	});
	const remove = useTagMutation(api.deleteTag);
	const open = (tag: Tag | null) => {
		setEditing(tag);
		persistedTag.current = null;
		const current = classifiers.data?.find((c) => c.tag_id === tag?.id);
		setClassifier(current);
		setAutomation(automationDraft(current));
		setName(tag?.name ?? "");
		setColor(tag?.color ?? "#2563eb");
		save.reset();
	};
	return (
		<>
			<TagGroups onNewTag={() => open(null)}>
				{catalog.isPending && <p>Loading tags…</p>}
				{catalog.data
					?.filter((tag) => !tag.group_id)
					.map((tag) => (
						<div
							key={tag.id}
							className="group flex items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-kumo-tint"
						>
							<button
								type="button"
								className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left"
								aria-label={`Edit tag ${tag.name}`}
								disabled={
									classifiers.available &&
									(classifiers.isPending || classifiers.isError)
								}
								onClick={() => open(tag)}
							>
								<TagChips tags={[tag]} />
								<span className="text-xs text-kumo-subtle">
									{classifiers.available && !classifiers.data
										? "…"
										: classifiers.data?.find((c) => c.tag_id === tag.id)
													?.enabled
											? "Jev"
											: "Manual"}
								</span>
							</button>
							<div className="flex shrink-0 gap-1">
								<Button
									size="sm"
									variant="ghost"
									disabled={remove.isPending}
									aria-label={`Delete tag ${tag.name}`}
									onClick={() => {
										if (
											window.confirm(
												`Delete “${tag.name}” from all mailboxes and conversations? This cannot be undone.`,
											)
										)
											remove.mutate(tag.id);
									}}
								>
									<TrashIcon size={15} />
								</Button>
							</div>
						</div>
					))}
				{(catalog.error || remove.error || classifiers.error) && (
					<p role="alert" className="text-sm text-kumo-danger">
						{(catalog.error || remove.error || classifiers.error)?.message}
					</p>
				)}
			</TagGroups>
			<Dialog.Root
				open={editing !== undefined}
				onOpenChange={(isOpen) => {
					if (!isOpen && !save.isPending) setEditing(undefined);
				}}
			>
				<Dialog size="base" className="max-h-[90dvh] overflow-y-auto p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						{editing ? "Edit tag" : "New tag"}
					</Dialog.Title>
					<form
						className="space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							if (name.trim() && !save.isPending)
								save.mutate(undefined, {
									onSuccess: () => setEditing(undefined),
								});
						}}
					>
						<Input
							label="Tag name"
							required
							autoFocus
							maxLength={80}
							value={name}
							disabled={save.isPending}
							onChange={(e) => setName(e.target.value)}
						/>
						<fieldset disabled={save.isPending} className="space-y-3">
							<legend className="mb-2 text-sm font-medium">Color</legend>
							<div className="flex flex-wrap gap-2">
								{COLORS.map(([label, hex]) => (
									<button
										key={hex}
										type="button"
										aria-label={`${label} color`}
										aria-pressed={color.toLowerCase() === hex}
										onClick={() => setColor(hex)}
										className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-transparent text-white transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2"
										style={{
											backgroundColor: hex,
											outline:
												color.toLowerCase() === hex
													? `2px solid ${hex}`
													: undefined,
											outlineOffset: 2,
										}}
									>
										{color.toLowerCase() === hex && (
											<CheckIcon size={14} weight="bold" />
										)}
									</button>
								))}
							</div>
							<label className="flex items-center gap-2 text-xs text-kumo-subtle">
								<input
									aria-label="Tag color"
									type="color"
									value={color}
									onChange={(e) => setColor(e.target.value)}
									className="h-6 w-6 cursor-pointer overflow-hidden rounded border-0 bg-transparent p-0"
								/>
								Custom color
								<span className="ml-auto font-mono">{color.toUpperCase()}</span>
							</label>
						</fieldset>
						<div className="rounded-lg border border-dashed border-kumo-line bg-kumo-tint px-4 py-4">
							<p className="mb-2.5 text-xs text-kumo-subtle">Preview</p>
							<TagChips
								tags={[
									{ id: "preview", name: name.trim() || "Your tag", color },
								]}
							/>
						</div>

						{classifiers.available && (
							<AutomationFields
								key={editing?.id ?? "new"}
								value={automation}
								onChange={setAutomation}
								onValidityChange={setAutomationValid}
								disabled={save.isPending || !classifiers.canManage}
							/>
						)}
						{classifiers.error && (
							<p role="alert" className="text-sm text-kumo-danger">
								Unable to load Jev settings: {classifiers.error.message}
							</p>
						)}
						{classifier && classifiers.canManage && (
							<ExistingConversations
								classifiers={
									classifiers.data?.filter((c) => c.id === classifier.id) ?? [
										classifier,
									]
								}
								disabled={
									save.isPending ||
									name !== editing?.name ||
									color !== editing?.color ||
									JSON.stringify(automation) !==
										JSON.stringify(automationDraft(classifier))
								}
							/>
						)}

						{save.error && (
							<p role="alert" className="text-sm text-kumo-danger">
								{save.error.message}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="secondary"
								disabled={save.isPending}
								onClick={() => setEditing(undefined)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								variant="primary"
								disabled={!name.trim() || save.isPending || !automationValid}
							>
								Save tag
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</>
	);
}
