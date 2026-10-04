import type { SenderConfiguration } from "shared/senders";

export default function SenderSelect({
	config,
	value,
	onChange,
	disabled,
	label = "From",
}: {
	config?: SenderConfiguration;
	value: string;
	onChange: (id: string) => void;
	disabled?: boolean;
	label?: string;
}) {
	return (
		<label className="block text-sm font-medium text-kumo-default">
			{label}
			<select
				aria-label={label}
				className="mt-1 block w-full rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
				value={value}
				onChange={(e) => onChange(e.target.value)}
				disabled={disabled || !config}
			>
				<option value="" disabled>
					{config ? "Choose a sender" : "Loading senders…"}
				</option>
				{config?.senders.map((sender) => (
					<option
						key={sender.id}
						value={sender.id}
						disabled={!sender.active || !sender.mailbox_id}
					>
						{sender.name} &lt;{sender.email}&gt;
						{sender.id === config.default_sender_identity_id
							? " (default)"
							: ""}
						{!sender.active || !sender.mailbox_id ? " — unavailable" : ""}
					</option>
				))}
			</select>
		</label>
	);
}
