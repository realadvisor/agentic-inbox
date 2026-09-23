import { Button, Dialog, Input } from "@cloudflare/kumo";
import {
	TagIcon,
	PlusIcon,
	PencilSimpleIcon,
	TrashIcon,
	CheckIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTags, useTagMutation } from "~/queries/tags";
import api from "~/services/api";
import type { Tag } from "~/types";
import { TagChips } from "./ConversationTags";

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
	const save = useTagMutation(() =>
		editing
			? api.updateTag(editing.id, { name, color })
			: api.createTag({ name, color }),
	);
	const remove = useTagMutation(api.deleteTag);
	const open = (tag: Tag | null) => {
		setEditing(tag);
		setName(tag?.name ?? "");
		setColor(tag?.color ?? "#2563eb");
		save.reset();
	};
	return (
		<section className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
			<div className="flex items-center justify-between gap-4 p-5">
				<div className="flex items-center gap-3">
					<div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle">
						<TagIcon size={21} />
					</div>
					<div>
						<h2 className="text-sm font-semibold">
							Tags{" "}
							<span className="ml-1.5 text-xs font-normal text-kumo-subtle">
								{catalog.data?.length ?? 0}
							</span>
						</h2>
						<p className="mt-0.5 text-xs text-kumo-subtle">
							Organize your team’s conversations.
						</p>
					</div>
				</div>
				<Button
					size="sm"
					variant="primary"
					icon={<PlusIcon size={14} />}
					onClick={() => open(null)}
				>
					New tag
				</Button>
			</div>
			<div className="border-t border-kumo-line px-5 py-2.5 text-xs text-kumo-subtle bg-kumo-tint">
				Shared across all mailboxes
			</div>

			{catalog.isPending && <p>Loading tags…</p>}
			{catalog.data?.length === 0 && (
				<p className="p-5 text-sm text-kumo-subtle">
					Create your first tag to organize conversations.
				</p>
			)}
			{catalog.data?.map((tag) => (
				<div
					key={tag.id}
					className="group flex items-center justify-between gap-3 border-t border-kumo-line px-5 py-3.5 transition-colors hover:bg-kumo-tint"
				>
					<TagChips tags={[tag]} />
					<div className="flex shrink-0 gap-1">
						<Button
							size="sm"
							variant="ghost"
							aria-label={`Edit tag ${tag.name}`}
							onClick={() => open(tag)}
						>
							<PencilSimpleIcon size={15} />
						</Button>
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
			{(catalog.error || remove.error) && (
				<p role="alert" className="text-sm text-kumo-danger">
					{(catalog.error || remove.error)?.message}
				</p>
			)}
			<Dialog.Root
				open={editing !== undefined}
				onOpenChange={(isOpen) => {
					if (!isOpen && !save.isPending) setEditing(undefined);
				}}
			>
				<Dialog size="sm" className="p-6">
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
								disabled={!name.trim() || save.isPending}
							>
								Save tag
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</section>
	);
}
