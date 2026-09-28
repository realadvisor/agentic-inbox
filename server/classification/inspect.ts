import type { Database } from "../db";
import { HTTPException } from "hono/http-exception";

/** Current, mailbox-scoped state only. Provider request/response logs are private. */
export async function inspectClassifications(
	db: Database,
	mailbox: string,
	thread: string,
) {
	const [conversation] =
		await db`SELECT generation FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${thread}`;
	if (!conversation)
		throw new HTTPException(404, { message: "Conversation not found" });
	const rows =
		await db`SELECT j.classifier_id,j.revision,j.generation,j.token,j.status,j.answer,j.probability,j.score,j.confidence,j.source,j.actor,j.model,j.error,j.updated_at,c.question,c.decision_rules,t.id AS tag_id,t.name,t.group_id,g.name AS group_name,g.selection,g.instructions,
 tag_manually_overridden(j.mailbox_id,j.thread_id,c.tag_id) AS manually_overridden,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'name',l.name,'position',l.position,'description',l.description) ORDER BY l.position,l.id),'[]'::jsonb) FROM tags l WHERE l.group_id=t.group_id AND l.archived_at IS NULL) AS levels
 FROM conversation_classifications j JOIN classifiers c ON c.id=j.classifier_id JOIN conversations v ON v.mailbox_id=j.mailbox_id AND v.thread_id=j.thread_id JOIN tags t ON t.id=c.tag_id LEFT JOIN tag_groups g ON g.id=t.group_id
 WHERE j.mailbox_id=${mailbox} AND j.thread_id=${thread} AND j.revision=c.revision AND j.generation=v.generation AND t.archived_at IS NULL AND (c.enabled OR j.priority=2) ORDER BY t.name,j.classifier_id LIMIT 101`;
	return {
		thread_id: thread,
		generation: conversation.generation,
		results: rows.slice(0, 100),
		truncated: rows.length > 100,
		explanation:
			"Scores and confidence are recorded outputs, not an explanation of the model's reasoning. Overridden results are informational only. Do not invent a rationale.",
	};
}
