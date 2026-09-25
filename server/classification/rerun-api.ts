import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
export function rerunApi(
	db: Database,
	admin: boolean,
	kick?: (tokens?: string[]) => void,
) {
	const app = new Hono();
	app.use("/threads/*", async (c, next) => {
		if (!admin)
			throw new HTTPException(403, {
				message: "Only inbox administrators can run classifiers",
			});
		await next();
	});
	app.get("/threads/:mailbox/:thread", async (c) => {
		const mailbox = z.string().email().parse(c.req.param("mailbox")),
			thread = z.string().uuid().parse(c.req.param("thread"));
		const jobs =
			await db`SELECT j.status,j.error FROM conversation_classifications j JOIN classifiers c ON c.id=j.classifier_id WHERE j.mailbox_id=${mailbox} AND j.thread_id=${thread} AND j.priority=2 AND c.revision=j.revision`;
		return c.json({
			pending: jobs.filter((j) => j.status === "pending").length,
			complete: jobs.filter((j) => j.status === "complete").length,
			review: jobs.filter((j) => j.status === "review").length,
			failed: jobs.filter((j) => j.status === "error").length,
			skipped: jobs.filter((j) => j.status === "skipped").length,
		});
	});
	app.post("/threads/:mailbox/:thread/rerun", async (c) => {
		const mailbox = z.string().email().parse(c.req.param("mailbox")),
			thread = z.string().uuid().parse(c.req.param("thread"));
		const result = await db.begin(async (tx) => {
			const classifiers =
				await tx`SELECT c.id,c.tag_id,c.revision FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.archived_at IS NULL AND length(trim(c.question))>0 AND (cardinality(c.mailbox_ids)=0 OR ${mailbox}=ANY(c.mailbox_ids)) ORDER BY c.id FOR UPDATE OF c`;
			const [conversation] =
				await tx`SELECT generation FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${thread} FOR UPDATE`;
			if (!conversation)
				throw new HTTPException(404, { message: "Conversation not found" });
			const [eligible] =
				await tx`SELECT 1 FROM emails WHERE mailbox_id=${mailbox} AND thread_id=${thread} AND delivery_status IN ('received','sent') AND folder_id NOT IN ('trash','spam') LIMIT 1`;
			if (!eligible)
				throw new HTTPException(400, {
					message:
						"Reclassification requires a received or sent conversation outside spam and trash.",
				});
			if (!classifiers.length)
				throw new HTTPException(400, {
					message: "Configure Jev for a tag or group in Settings → Tags first.",
				});
			const previous =
				await tx`SELECT c.id,tag_manually_overridden(${mailbox},${thread},c.tag_id) AS overridden,j.source,j.status,j.priority,j.revision,j.generation,j.token,j.run_id FROM classifiers c LEFT JOIN conversation_classifications j ON j.classifier_id=c.id AND j.mailbox_id=${mailbox} AND j.thread_id=${thread} WHERE c.id IN ${tx(classifiers.map((c) => c.id))}`;
			const tokens: string[] = [];
			let protectedCount = 0;
			const fresh = [];
			for (const classifier of classifiers) {
				const old = previous.find((j) => j.id === classifier.id)!;
				if (old.overridden || old.source === "human") {
					protectedCount++;
					continue;
				}
				if (
					old.status === "pending" &&
					old.priority === 2 &&
					old.revision === classifier.revision &&
					old.generation === conversation.generation
				) {
					tokens.push(old.token);
					continue;
				}
				fresh.push(classifier);
			}
			if (fresh.length) {
				const ids = fresh.map((c) => c.id);
				await tx`UPDATE classifier_run_items i SET status='skipped' FROM conversation_classifications j WHERE j.mailbox_id=${mailbox} AND j.thread_id=${thread} AND j.classifier_id IN ${tx(ids)} AND i.run_id=j.run_id AND i.mailbox_id=j.mailbox_id AND i.thread_id=j.thread_id AND i.status='pending'`;
				const jobs =
					await tx`INSERT INTO conversation_classifications ${tx(fresh.map((c) => ({ mailbox_id: mailbox, thread_id: thread, classifier_id: c.id, revision: c.revision, generation: conversation.generation, priority: 2 })))} ON CONFLICT(mailbox_id,thread_id,classifier_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,priority=2,run_id=NULL,status='pending',token=gen_random_uuid(),answer=NULL,probability=NULL,source='jev',actor=NULL,model=NULL,error=NULL,attempts=0,available_at=now(),lease_until=NULL,lease_id=NULL,updated_at=now() RETURNING token`;
				tokens.push(...jobs.map((j) => j.token));
				await tx`DELETE FROM conversation_tags WHERE mailbox_id=${mailbox} AND thread_id=${thread} AND tag_id IN ${tx(fresh.map((c) => c.tag_id))} AND source='classifier'`;
			}
			return { tokens, protected: protectedCount };
		});
		if (result.tokens.length) kick?.(result.tokens);
		return c.json(
			{ queued: result.tokens.length, protected: result.protected },
			202,
		);
	});
	return app;
}
