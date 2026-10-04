import { AppSelect } from "./AppSelect";
import type { SenderConfiguration } from "shared/senders";

export default function SenderSelect({
	config,
	value,
	onChange,
	disabled,
	label = "From",
	compact = false,
}: {
	config?: SenderConfiguration;
	value: string;
	onChange: (id: string) => void;
	disabled?: boolean;
	label?: string;
	compact?: boolean;
}) {
	return (
		<div
			className={
				compact
					? "flex min-w-0 items-center gap-2"
					: "text-sm font-medium text-kumo-default"
			}
		>
			<span
				className={
					compact
						? "w-10 shrink-0 text-xs font-normal text-kumo-subtle"
						: undefined
				}
			>
				{label}
			</span>
			<div className="min-w-0 flex-1">
				<AppSelect
					label={label}
					compact={compact}
					triggerClassName={
						compact
							? "max-w-full min-w-0 font-normal [&>span]:truncate"
							: undefined
					}
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
		</div>
	);
}
