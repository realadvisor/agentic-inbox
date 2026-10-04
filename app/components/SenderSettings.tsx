import { AppSelect } from "./AppSelect";
import { Button, Input, Loader } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon, PlusIcon } from "@phosphor-icons/react";
import {
	useSenders,
	useSetDefaultSender,
	useSaveSender,
	useRemoveSender,
} from "~/queries/senders";

import { useState } from "react";
import { useMailboxes } from "~/queries/mailboxes";
export default function SenderSettings({
	canManage = true,
	live = false,
}: {
	canManage?: boolean;
	live?: boolean;
}) {
	const save = useSaveSender();
	const remove = useRemoveSender();
	const mailboxes = useMailboxes();
	const [editor, setEditor] = useState<{
		id?: string;
		name: string;
		email: string;
		mailbox_id: string;
	} | null>(null);
	const [removing, setRemoving] = useState<string | null>(null);
	const pending = save.isPending || remove.isPending;

	const { data, error, isLoading, refetch } = useSenders();
	const update = useSetDefaultSender();
	const defaultSender = data?.senders.find(
		(sender) => sender.id === data.default_sender_identity_id,
	);
	return (
		<section
			className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base text-kumo-default"
			aria-labelledby="senders-heading"
		>
			<div className="flex items-center gap-3 p-5">
				<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle">
					<EnvelopeSimpleIcon size={21} />
				</div>
				<div className="flex-1">
					<h2 id="senders-heading" className="text-sm font-semibold">
						Senders
						{data && (
							<span className="ml-1.5 text-xs font-normal text-kumo-subtle">
								{data.senders.length}
							</span>
						)}
					</h2>
					<p className="mt-0.5 text-xs text-kumo-subtle">
						Choose the default sender for your inbox.
					</p>
				</div>

				{canManage && (
					<Button
						size="sm"
						variant="primary"
						icon={PlusIcon}
						onClick={() => {
							save.reset();
							setEditor({ name: "", email: "", mailbox_id: "" });
						}}
					>
						Add sender
					</Button>
				)}
			</div>
			{editor && (
				<form
					className="space-y-4 border-t border-kumo-line p-5"
					onSubmit={async (event) => {
						event.preventDefault();
						try {
							await save.mutateAsync(editor);
							setEditor(null);
						} catch {
							/* mutation renders error */
						}
					}}
				>
					<h3 className="text-sm font-semibold">
						{editor.id ? "Edit sender" : "Add sender"}
					</h3>
					<Input
						label="Sender name"
						required
						value={editor.name}
						onChange={(event) =>
							setEditor({ ...editor, name: event.target.value })
						}
					/>
					<Input
						label="Sender email"
						type="email"
						required
						value={editor.email}
						onChange={(event) =>
							setEditor({ ...editor, email: event.target.value })
						}
					/>
					<div className="text-sm">
						<span>Sending mailbox</span>
						<AppSelect
							label="Sending mailbox"
							value={editor.mailbox_id}
							disabled={pending || mailboxes.isPending}
							onChange={(mailbox_id) => setEditor({ ...editor, mailbox_id })}
							options={[
								{ value: "", label: "Select a mailbox", disabled: true },
								...(mailboxes.data ?? [])
									.filter((box) => box.email !== "all@ingest.realadvisor.com")
									.map((box) => ({
										value: box.id,
										label: `${box.name} — ${box.email}`,
									})),
							]}
						/>
					</div>
					{live && (
						<p className="text-xs text-kumo-subtle">
							Use the approved public address for the selected ingest mailbox.
							For example, sales@realadvisor.com uses
							sales@ingest.realadvisor.com.
						</p>
					)}
					{save.error && (
						<p role="alert" className="text-sm text-kumo-danger">
							{save.error.message}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							size="sm"
							disabled={pending}
							onClick={() => setEditor(null)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							size="sm"
							variant="primary"
							loading={save.isPending}
							disabled={pending || !editor.mailbox_id}
						>
							Save sender
						</Button>
					</div>
				</form>
			)}
			{data && (
				<div className="space-y-2 border-y border-kumo-line bg-kumo-tint px-5 py-3 text-xs text-kumo-subtle">
					<p>
						Default for new messages:{" "}
						<strong>{defaultSender?.email ?? "Not set"}</strong>.
					</p>
					<p>
						Replies use the matching receiving address, or the default when
						there is no match. You can choose another sender in the composer.
					</p>
				</div>
			)}
			{isLoading && (
				<div
					role="status"
					className="flex items-center justify-center gap-3 border-t border-kumo-line p-10 text-sm text-kumo-subtle"
				>
					<Loader size="sm" /> Loading senders…
				</div>
			)}
			{error && (
				<p
					role="alert"
					className="border-t border-kumo-line px-5 py-3 text-sm text-kumo-danger"
				>
					Could not load senders.{" "}
					<button
						type="button"
						className="underline"
						onClick={() => void refetch()}
					>
						Retry
					</button>
				</p>
			)}
			{data && (
				<div className="divide-y divide-kumo-line">
					{data.senders.map((sender) => {
						const isDefault = sender.id === data.default_sender_identity_id;
						const available = sender.active && !!sender.mailbox_id;
						return (
							<div
								key={sender.id}
								className="flex items-center gap-3 px-5 py-4"
							>
								<div className="min-w-0 flex-1">
									<p className="break-words text-sm font-medium">
										{sender.name}
									</p>
									<p className="break-all text-xs text-kumo-subtle">
										{sender.email}
									</p>
									{!available && (
										<p className="text-xs text-kumo-subtle">
											Sender unavailable
										</p>
									)}
								</div>
								<Button
									size="sm"
									className="shrink-0"
									variant={isDefault ? "primary" : "secondary"}
									disabled={
										update.isPending ||
										pending ||
										!canManage ||
										!available ||
										isDefault
									}
									aria-label={`Set ${sender.email} as default`}
									onClick={() => update.mutate(sender.id)}
								>
									{isDefault ? "Default" : "Set default"}
								</Button>
								{canManage && (
									<>
										<Button
											size="sm"
											disabled={pending}
											aria-label={`Edit ${sender.email}`}
											onClick={() => {
												save.reset();
												setEditor({
													id: sender.id,
													name: sender.name,
													email: sender.email,
													mailbox_id: sender.mailbox_id ?? "",
												});
											}}
										>
											Edit
										</Button>
										<Button
											size="sm"
											disabled={pending || isDefault}
											aria-label={`Remove ${sender.email}`}
											onClick={() => {
												remove.reset();
												setRemoving(sender.id);
											}}
										>
											Remove
										</Button>
									</>
								)}
							</div>
						);
					})}
					{!data.senders.length && (
						<p className="p-5 text-sm text-kumo-subtle">
							No senders available.
						</p>
					)}
				</div>
			)}
			{removing && (
				<div className="space-y-3 border-t border-kumo-line p-5">
					<p className="text-sm">
						Remove{" "}
						{data?.senders.find((sender) => sender.id === removing)?.email}?
						Existing messages are kept. Drafts using this sender will need
						another sender.
					</p>
					{remove.error && (
						<p role="alert" className="text-sm text-kumo-danger">
							{remove.error.message}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<Button
							size="sm"
							disabled={pending}
							onClick={() => setRemoving(null)}
						>
							Cancel
						</Button>
						<Button
							size="sm"
							variant="primary"
							disabled={pending}
							loading={remove.isPending}
							onClick={async () => {
								try {
									await remove.mutateAsync(removing);
									setRemoving(null);
								} catch {
									/* mutation renders error */
								}
							}}
						>
							Remove sender
						</Button>
					</div>
				</div>
			)}
			{update.error && (
				<p
					role="alert"
					className="border-t border-kumo-line px-5 py-3 text-sm text-kumo-danger"
				>
					{update.error.message}
				</p>
			)}
			{update.isSuccess && (
				<p
					role="status"
					className="border-t border-kumo-line px-5 py-3 text-xs text-kumo-subtle"
				>
					Default sender saved.
				</p>
			)}
		</section>
	);
}
