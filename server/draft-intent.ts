import { HTTPException } from "hono/http-exception";
import type { Email } from "../app/types/index";
import type { InboxStore } from "./store";

// Resolve persisted intent independently of RFC headers and loaded UI thread pages.
export async function draftSendIntent(
	store: InboxStore,
	mailbox: string,
	draft: Email | undefined,
	parentId?: string,
	isReply = false,
) {
	if (draft?.draft_mode) {
		const reply =
			draft.draft_mode === "reply" || draft.draft_mode === "reply-all";
		if (parentId && (parentId !== draft.draft_source_id || isReply !== reply))
			throw new HTTPException(409, {
				message: "Send action does not match saved draft intent",
			});
		parentId =
			draft.draft_mode === "new"
				? undefined
				: (draft.draft_source_id ?? undefined);
		isReply = reply;
		if (draft.draft_mode !== "new" && !parentId)
			throw new HTTPException(409, { message: "Draft source is missing" });
	} else if (draft) {
		// Legacy mode is ambiguous: never invent reply headers from an old UUID.
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
