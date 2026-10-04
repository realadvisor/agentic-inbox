import { useRef, useState } from "react";
import { useKumoToastManager } from "@cloudflare/kumo";
import {
	useForwardEmail,
	useReplyToEmail,
	useSendEmail,
} from "~/queries/emails";
import { draftDelivery } from "~/lib/draft-delivery";
import { submitComposition, type ComposeSubmission } from "~/lib/compose-send";
import { sendErrorMessage } from "~/lib/send-error";
import { notifyDraftDelivery, useDraftCleanup } from "./useDraftDelivery";

/** React adapter shared by inline/modal editors and direct draft submission. */
export function useComposerSend() {
	const send = useSendEmail();
	const reply = useReplyToEmail();
	const forward = useForwardEmail();
	const cleanup = useDraftCleanup();
	const toast = useKumoToastManager();
	const busy = useRef(false);
	const [isSending, setIsSending] = useState(false);
	return {
		isSending,
		submit: async (input: ComposeSubmission) => {
			if (busy.current) return { status: "blocked" as const };
			busy.current = true;
			setIsSending(true);
			try {
				const result = await submitComposition(input, {
					send: send.mutateAsync,
					reply: reply.mutateAsync,
					forward: forward.mutateAsync,
					ledger: draftDelivery,
					cleanup: cleanup.cleanup,
					notify: notifyDraftDelivery,
				});
				if (result.status === "accepted") {
					toast.add({ title: "Message submitted" });
					if (result.cleanupFailed)
						toast.add({
							title:
								"Message submitted. Draft cleanup failed; retry cleanup from the draft.",
						});
				}
				return result;
			} catch (error) {
				const message = sendErrorMessage(error);
				toast.add({ title: message, variant: "error" });
				throw new Error(message);
			} finally {
				busy.current = false;
				setIsSending(false);
			}
		},
	};
}
