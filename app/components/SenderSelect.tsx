import { AppSelect } from "./AppSelect";
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
		<div className="text-sm font-medium text-kumo-default">
			<span>{label}</span>
			<AppSelect
				label={label}
				value={value}
				onChange={onChange}
				disabled={disabled || !config}
				options={[
					{
						value: "",
						label: config ? "Choose a sender" : "Loading senders…",
						disabled: true,
					},
					...(config?.senders ?? []).map((sender) => ({
						value: sender.id,
						label: `${sender.name} <${sender.email}>${sender.id === config?.default_sender_identity_id ? " (default)" : ""}${!sender.active || !sender.mailbox_id ? " — unavailable" : ""}`,
						disabled: !sender.active || !sender.mailbox_id,
					})),
				]}
			/>
		</div>
	);
}
