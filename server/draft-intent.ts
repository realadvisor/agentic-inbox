import { HTTPException } from "hono/http-exception";
import type { Email } from "../app/types/index";
import type { InboxStore } from "./store";

export class DraftIntentConflict extends HTTPException {
	// Set only after outbound idempotency lookup proves this key has no attempt.
	rejectedRequestId?: string;
	constructor(message: string) {
		super(422, {
			message: `${message} Nothing was sent by this request. Keep any unsaved text, reload the app and reopen the draft before sending.`,
		});
	}
}

// Resolve persisted intent independently of RFC headers and loaded UI thread pages.
export async function draftSendIntent(
	store: InboxStore,
	mailbox: string,
	draft: Email | undefined,
	parentId?: string,
	isReply = false,
	requestedMode?: Email["draft_mode"],
) {
	if (draft?.draft_mode) {
		const reply =
			draft.draft_mode === "reply" || draft.draft_mode === "reply-all";
		if (
			(requestedMode && requestedMode !== draft.draft_mode) ||
			(parentId && (parentId !== draft.draft_source_id || isReply !== reply))
		)
			throw new DraftIntentConflict(
				"This tab's send action does not match the saved draft intent.",
			);
		parentId =
			draft.draft_mode === "new"
				? undefined
				: (draft.draft_source_id ?? undefined);
		isReply = reply;
		if (draft.draft_mode !== "new" && !parentId)
			throw new HTTPException(409, { message: "Draft source is missing" });
	} else if (draft) {
		// Only a refreshed client that visibly discloses the new-conversation
		// fallback may send an ambiguous legacy draft without reply headers.
		if (parentId || requestedMode !== "new")
			throw new DraftIntentConflict(
				"This draft's original reply/forward intent is unknown.",
			);
		parentId = undefined;
		isReply = false;
	}
	const parent = parentId ? await store.message(mailbox, parentId) : undefined;
	if (parent?.delivery_status === "draft")
		throw new HTTPException(400, {
			message: "Draft source must be a delivered message",
		});
	return { parent, isReply };
}
