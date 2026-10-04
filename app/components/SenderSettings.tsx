import { Button, Loader } from "@cloudflare/kumo";
import { EnvelopeSimpleIcon } from "@phosphor-icons/react";
import { useSenders, useSetDefaultSender } from "~/queries/senders";

export default function SenderSettings() {
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
				<div>
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
			</div>
			{data && (
				<div className="space-y-2 border-y border-kumo-line bg-kumo-tint px-5 py-3 text-xs text-kumo-subtle">
					<p>
						Default for new messages:{" "}
						<strong>{defaultSender?.email ?? "Not set"}</strong>.
					</p>
					<p>
						Replies use the matching receiving address. You can choose another
						sender in the composer.
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
									disabled={update.isPending || !available || isDefault}
									aria-label={`Set ${sender.email} as default`}
									onClick={() => update.mutate(sender.id)}
								>
									{isDefault ? "Default" : "Set default"}
								</Button>
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
