import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
export const reviewInput = z
	.object({
		answer: z.boolean(),
		revision: z.number().int(),
		token: z.string().uuid(),
	})
	.strict();
const fail = (status: 400 | 409, message: string): never => {
	throw new HTTPException(status, { message });
};
/** Caller owns the transaction; token/revision/generation fence stale decisions. */
export async function reviewClassification(
	tx: Database,
	mailbox: string,
	thread: string,
	classifierId: string,
	data: z.infer<typeof reviewInput>,
	actor: string,
	source: "human" | "agent" = "human",
) {
	const [classifier] =
		await tx`SELECT *,to_json(mailbox_ids) AS mailbox_ids FROM classifiers WHERE id=${classifierId} FOR UPDATE`;
	const [reviewJob] =
		await tx`SELECT priority,generation,source FROM conversation_classifications WHERE mailbox_id=${mailbox} AND thread_id=${thread} AND classifier_id=${classifierId} AND token=${data.token}`;
	if (
		!classifier ||
		(!classifier.enabled && reviewJob?.priority !== 2) ||
		classifier.revision !== data.revision
	)
		fail(409, "Classifier changed; refresh and try again");
	const [conversation] =
		await tx`SELECT generation FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${thread} FOR UPDATE`;
	if (!conversation || conversation.generation !== reviewJob?.generation)
		fail(409, "Conversation changed; refresh and try again");
	if (source === "agent" && reviewJob?.source === "human")
		fail(409, "Human-reviewed corrections are protected");
	const [definition] =
		await tx`SELECT t.archived_at,g.selection,tag_manually_overridden(${mailbox},${thread},t.id) AS overridden FROM tags t LEFT JOIN tag_groups g ON g.id=t.group_id WHERE t.id=${classifier.tag_id}`;
	if (definition?.archived_at || definition?.overridden)
		fail(409, "Tag has a manual override or was archived");
	if (source === "agent" && ["single", "score"].includes(definition?.selection))
		fail(
			400,
			"Choice and ordered-scale reviews require explicit tag selection, not a boolean classification review",
		);
	const [row] =
		await tx`UPDATE conversation_classifications SET answer=${data.answer},source=${source},actor=${actor},status='complete',probability=NULL,score=NULL,confidence=NULL,token=gen_random_uuid(),lease_until=NULL,updated_at=now() WHERE mailbox_id=${mailbox} AND thread_id=${thread} AND classifier_id=${classifierId} AND token=${data.token} RETURNING *`;
	if (!row) fail(409, "Conversation changed; refresh and try again");
	const [tag] =
		await tx`SELECT group_id FROM tags WHERE id=${classifier.tag_id}`;
	await tx`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at) VALUES(${mailbox},${thread},${classifier.tag_id},${tag.group_id ? "manual" : "classifier"},${actor},${data.answer ? null : tx`now()`}) ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET source=excluded.source,actor=excluded.actor,removed_at=excluded.removed_at,updated_at=now() WHERE conversation_tags.source='classifier'`;
	if (row.run_id)
		await tx`UPDATE classifier_run_items SET status='complete' WHERE run_id=${row.run_id} AND mailbox_id=${mailbox} AND thread_id=${thread} AND status='pending'`;
	return {
		thread_id: thread,
		classifier_id: classifierId,
		answer: data.answer,
		source,
		actor,
	};
}
