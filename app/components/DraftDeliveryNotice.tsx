import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import { useDraftCleanup, useDraftDelivery } from "~/hooks/useDraftDelivery";

export default function DraftDeliveryNotice({
	mailboxId,
	draftId,
	legacyIntent = false,
}: {
	mailboxId?: string;
	draftId?: string;
	legacyIntent?: boolean;
}) {
	const state = useDraftDelivery(mailboxId, draftId);
	const remove = useDraftCleanup();
	const [failed, setFailed] = useState(false);
	if (!state)
		return legacyIntent ? (
			<p role="status" className="p-3 text-sm border-b border-kumo-line">
				This older draft's original reply/forward intent is unknown. Sending
				starts a new conversation. To reply in the original thread, compose a
				fresh reply and copy your text.
			</p>
		) : null;
	return (
		<div role="status" className="p-3 text-sm border-b border-kumo-line">
			<p>Message submitted. This draft cannot be sent again.</p>
			{state === "accepted" && (
				<>
					<p>
						{failed
							? "Draft cleanup failed. You can retry cleanup safely."
							: "Draft cleanup is pending. Retrying cleanup does not send email."}
					</p>
					<Button
						type="button"
						size="sm"
						disabled={remove.isPending}
						onClick={async () => {
							if (!mailboxId || !draftId) return;
							setFailed(false);
							try {
								await remove.cleanup(mailboxId, draftId);
							} catch {
								setFailed(true);
							}
						}}
					>
						Retry draft cleanup
					</Button>
				</>
			)}
		</div>
	);
}
