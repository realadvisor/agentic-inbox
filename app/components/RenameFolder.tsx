import { Button, Dialog, Input } from "@cloudflare/kumo";
import { PencilSimpleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useUpdateFolder } from "~/queries/folders";
import type { Folder } from "~/types";

export function RenameFolder({
	mailboxId,
	folder,
}: {
	mailboxId: string;
	folder: Folder;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(folder.name);
	const mutation = useUpdateFolder();
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				shape="square"
				icon={<PencilSimpleIcon size={14} />}
				aria-label={`Rename ${folder.name}`}
				onClick={() => {
					setName(folder.name);
					mutation.reset();
					setOpen(true);
				}}
			/>
			<Dialog.Root
				open={open}
				onOpenChange={(next) => {
					if (!mutation.isPending) setOpen(next);
				}}
			>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold mb-4">
						Rename folder
					</Dialog.Title>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (!name.trim() || mutation.isPending) return;
							mutation.mutate(
								{ mailboxId, id: folder.id, name: name.trim() },
								{ onSuccess: () => setOpen(false) },
							);
						}}
					>
						<Input
							label="Folder name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={100}
							required
							autoFocus
							disabled={mutation.isPending}
						/>
						{mutation.error && (
							<p role="alert" className="text-sm text-kumo-danger">
								{mutation.error.message}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="secondary"
								disabled={mutation.isPending}
								onClick={() => setOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								variant="primary"
								disabled={
									!name.trim() ||
									name.trim() === folder.name ||
									mutation.isPending
								}
							>
								{mutation.isPending ? "Saving…" : "Save"}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</>
	);
}
