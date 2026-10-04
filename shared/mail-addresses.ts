import type { SenderIdentity } from "./senders";

/** Address fields in the inbox API contain bare email addresses. */
export function normalizeMailAddress(address: string): string {
	return address.trim().toLowerCase();
}

function mailboxIdentity(address: string): string {
	return normalizeMailAddress(address).replace(
		/@ingest\.realadvisor\.com$/,
		"@realadvisor.com",
	);
}

/** The receive and public sending addresses represent the same mailbox. */
export function isMailboxSelfAddress(
	address: string,
	mailbox?: string,
	senders: readonly Pick<SenderIdentity, "email" | "mailbox_id">[] = [],
): boolean {
	const selfAddresses = [
		mailbox,
		...senders.flatMap((sender) => [sender.email, sender.mailbox_id]),
	];
	return selfAddresses.some(
		(self) =>
			self?.trim() && mailboxIdentity(address) === mailboxIdentity(self),
	);
}
