import { useSenders, useSetDefaultSender } from "~/queries/senders";
import SenderSelect from "./SenderSelect";

export default function SenderSettings() {
	const { data, error } = useSenders();
	const update = useSetDefaultSender();
	return (
		<section className="rounded-lg border border-kumo-line bg-kumo-base p-5 my-4">
			<h2 className="text-sm font-medium mb-3">Senders</h2>
			<SenderSelect
				label="Default sender"
				config={data}
				value={data?.default_sender_identity_id ?? ""}
				onChange={(id) => update.mutate(id)}
				disabled={update.isPending}
			/>
			<p className="mt-2 text-sm text-kumo-subtle">
				Used for new messages. Replies use the receiving mailbox unless you
				choose another sender.
			</p>
			{(error || update.error) && (
				<p role="alert">{(error || update.error)?.message}</p>
			)}
			{update.isSuccess && (
				<p role="status" className="mt-2 text-sm">
					Default sender saved.
				</p>
			)}
		</section>
	);
}
