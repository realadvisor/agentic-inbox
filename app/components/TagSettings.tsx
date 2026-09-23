import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useState } from "react";
import { useTags, useTagMutation } from "~/queries/tags";
import api from "~/services/api";
import type { Tag } from "~/types";
import { TagChips } from "./ConversationTags";

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
		<section className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-4">
			<div className="flex justify-between items-center">
				<h2 className="text-sm font-medium">Tags</h2>
				<Button size="sm" onClick={() => open(null)}>
					New tag
				</Button>
			</div>
			<p className="text-sm text-kumo-subtle">
				Shared across all mailboxes. Apply tags to conversations independently
				of folders.
			</p>
			{catalog.isPending && <p>Loading tags…</p>}
			{catalog.data?.length === 0 && (
				<p className="text-sm text-kumo-subtle">No tags yet.</p>
			)}
			{catalog.data?.map((tag) => (
				<div key={tag.id} className="flex items-center justify-between gap-2">
					<TagChips tags={[tag]} />
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="secondary"
							aria-label={`Edit tag ${tag.name}`}
							onClick={() => open(tag)}
						>
							Edit
						</Button>
						<Button
							size="sm"
							variant="secondary"
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
							Delete
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
						<label className="flex items-center gap-3 text-sm">
							Tag color
							<input
								aria-label="Tag color"
								type="color"
								value={color}
								disabled={save.isPending}
								onChange={(e) => setColor(e.target.value)}
							/>
						</label>
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
