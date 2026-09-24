import { HTTPException } from "hono/http-exception";
import type { Database } from "./db";

/** Atomic, mailbox-scoped manual choices. Removals persist to protect human intent. */
export async function setConversationTags(
	db: Database,
	mailbox: string,
	threads: string[],
	tagId: string,
	action: "add" | "remove",
	actor: string,
) {
	const ids = [...new Set(threads)].sort();
	await db.begin(async (tx) => {
		const [tag] =
			await tx`SELECT id FROM tags WHERE id = ${tagId} AND archived_at IS NULL FOR KEY SHARE`;
		if (!tag) throw new HTTPException(404, { message: "Tag not found" });
		const found =
			await tx`SELECT thread_id FROM conversations c WHERE mailbox_id = ${mailbox} AND thread_id IN ${tx(ids)} AND EXISTS (SELECT 1 FROM emails e WHERE e.mailbox_id=c.mailbox_id AND e.thread_id=c.thread_id) ORDER BY thread_id FOR UPDATE`;
		if (found.length !== ids.length)
			throw new HTTPException(404, {
				message: "Conversation not found in this mailbox",
			});
		await tx`INSERT INTO conversation_tags (mailbox_id, thread_id, tag_id, source, actor, removed_at)
		SELECT c.mailbox_id, c.thread_id, ${tagId}::uuid, 'manual', ${actor}, ${action === "remove" ? tx`clock_timestamp()` : null}
		FROM conversations c WHERE c.mailbox_id=${mailbox} AND c.thread_id IN ${tx(ids)} ORDER BY c.thread_id
		ON CONFLICT (mailbox_id, thread_id, tag_id) DO UPDATE SET
		 source='manual', actor=EXCLUDED.actor, updated_at=clock_timestamp(), removed_at=EXCLUDED.removed_at`;
	});
}
