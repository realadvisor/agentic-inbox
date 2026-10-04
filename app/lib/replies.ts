import type { SenderIdentity } from "shared/senders";
import {
	isMailboxSelfAddress,
	normalizeMailAddress,
} from "shared/mail-addresses";
import { Folders } from "shared/folders";
import type { Email } from "~/types";
import { splitEmailList } from "./utils";

/** Delivery status is authoritative; sender identity and folder can change. */
export function getLastReceivedMessage(
	messages: readonly Email[],
	draftIds: ReadonlySet<string> = new Set(),
): Email | undefined {
	return messages.reduce<Email | undefined>((latest, message) => {
		if (
			message.delivery_status !== "received" ||
			message.folder_id === Folders.DRAFT ||
			draftIds.has(message.id)
		)
			return latest;
		return !latest ||
			new Date(message.date).getTime() > new Date(latest.date).getTime()
			? message
			: latest;
	}, undefined);
}

export function getReplyAddress(
	original: Pick<Email, "reply_to" | "sender">,
): string {
	return original.reply_to?.trim() || original.sender.trim();
}

export function buildReplyAllFields(
	original: Pick<Email, "reply_to" | "sender" | "recipient" | "cc">,
	selfAddress?: string,
	senders: readonly SenderIdentity[] = [],
) {
	const seen = new Set<string>();
	const unique = (addresses: string[]) =>
		addresses.filter((address) => {
			const normalized = normalizeMailAddress(address);
			if (
				!normalized ||
				isMailboxSelfAddress(normalized, selfAddress, senders) ||
				seen.has(normalized)
			)
				return false;
			seen.add(normalized);
			return true;
		});
	const to = unique([
		getReplyAddress(original),
		...splitEmailList(original.recipient),
	]);
	const cc = unique(splitEmailList(original.cc));
	return { to: to.join(", "), cc: cc.join(", "), showCcBcc: cc.length > 0 };
}
