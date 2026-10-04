import type { MailboxSettings } from "../app/types/index";
export interface SenderIdentity {
	id: string;
	email: string;
	mailbox_id: string | null;
	name: string;
	active: boolean;
	settings?: MailboxSettings;
}
export interface SenderConfiguration {
	senders: SenderIdentity[];
	default_sender_identity_id: string | null;
}
export interface SenderContext {
	explicit?: string;
	draft?: string | null;
	reply?: {
		recipient: string;
		cc?: string;
		sender_identity_id?: string | null;
	};
	mailboxId: string;
}
// Do not skip inactive matches: the caller must report an unavailable sender.
export function resolveSenderId(
	config: SenderConfiguration,
	context: SenderContext,
): string | null {
	if (context.explicit) return context.explicit;
	if (context.draft) return context.draft;
	if (context.reply) {
		if (context.reply.sender_identity_id)
			return context.reply.sender_identity_id;
		const recipients: string[] =
			`${context.reply.recipient},${context.reply.cc ?? ""}`
				.toLowerCase()
				.match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/g) ?? [];
		const matches = config.senders.filter(
			(s) =>
				recipients.includes(s.email.toLowerCase()) ||
				(s.mailbox_id && recipients.includes(s.mailbox_id.toLowerCase())),
		);
		if (matches.length === 1) return matches[0].id;
		if (matches.length > 1) return null;
		const mailboxSender = config.senders.find(
			(s) => s.mailbox_id === context.mailboxId,
		);
		if (mailboxSender) return mailboxSender.id;
	}
	return (
		config.default_sender_identity_id ??
		config.senders.find((s) => s.mailbox_id === context.mailboxId)?.id ??
		null
	);
}
