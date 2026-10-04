import type { ComposeMode } from "../hooks/useUIStore";
import type { SenderIdentity } from "../../shared/senders";
import type { ComposeFormFields } from "./compose-fields";
import type { DraftDeliveryLedger } from "./draft-delivery";
import { htmlToPlainText, splitEmailList, toEmailListValue } from "./utils";

/** A snapshot of editor or persisted draft fields. The API's SendIntents journal
 * alone owns immutable requests/keys and recovery after an uncertain response. */
export interface ComposeSubmission {
	mailboxId: string;
	sendScope: string;
	draftId?: string;
	mode: ComposeMode;
	sourceId?: string;
	sender?: SenderIdentity;
	fields: Omit<ComposeFormFields, "showCcBcc">;
}

export function prepareComposeSend(input: ComposeSubmission) {
	if (!input.sender?.active || !input.sender.mailbox_id)
		throw new Error("Choose an available sender.");
	const to = toEmailListValue(splitEmailList(input.fields.to));
	if (!to) throw new Error("Add at least one recipient.");
	if (input.mode !== "new" && !input.sourceId)
		throw new Error(
			"The original message is missing. Reopen the draft before sending.",
		);
	return {
		mailboxId: input.mailboxId,
		sendScope: input.draftId || input.sendScope,
		email: {
			to,
			cc: toEmailListValue(splitEmailList(input.fields.cc)),
			bcc: toEmailListValue(splitEmailList(input.fields.bcc)),
			sender_identity_id: input.sender.id,
			draft_id: input.draftId,
			draft_mode: input.mode,
			subject: input.fields.subject,
			html: input.fields.body,
			text: htmlToPlainText(input.fields.body),
		},
	};
}

type SendRequest = ReturnType<typeof prepareComposeSend>;
interface ComposeSendDependencies {
	send: (request: SendRequest) => Promise<unknown>;
	reply: (request: SendRequest & { emailId: string }) => Promise<unknown>;
	forward: (request: SendRequest & { emailId: string }) => Promise<unknown>;
	ledger: DraftDeliveryLedger;
	cleanup: (mailbox: string, draft: string) => Promise<unknown>;
	notify: () => void;
}

/** One operation, not another delivery state machine. Accepted receipts and
 * cleanup-only recovery remain in the existing draft ledger. */
export async function submitComposition(
	input: ComposeSubmission,
	deps: ComposeSendDependencies,
): Promise<
	{ status: "blocked" } | { status: "accepted"; cleanupFailed: boolean }
> {
	if (input.draftId && deps.ledger.read(input.mailboxId, input.draftId))
		return { status: "blocked" };
	const request = prepareComposeSend(input);
	const send = () => {
		if (input.mode === "reply" || input.mode === "reply-all")
			return deps.reply({ ...request, emailId: input.sourceId! });
		if (input.mode === "forward")
			return deps.forward({ ...request, emailId: input.sourceId! });
		return deps.send(request);
	};
	try {
		if (input.draftId) {
			if (!(await deps.ledger.submit(input.mailboxId, input.draftId, send)))
				return { status: "blocked" };
		} else await send();
	} finally {
		deps.notify();
	}
	// Never catch cleanup with the delivery request: acceptance is irrevocable.
	try {
		if (input.draftId) await deps.cleanup(input.mailboxId, input.draftId);
		return { status: "accepted", cleanupFailed: false };
	} catch {
		return { status: "accepted", cleanupFailed: true };
	} finally {
		deps.notify();
	}
}
