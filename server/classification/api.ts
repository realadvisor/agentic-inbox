import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
import { finishRuns } from "./queue";
const id = z.string().uuid();
const input = z
	.object({
		question: z.string().trim().min(1).max(4000),
		tag_id: id,
		mailbox_ids: z.array(z.string().email()).max(50),
		enabled: z.boolean(),
		revision: z.number().int().positive().optional(),
	})
	.strict();
const fail = (status: 400 | 403 | 404 | 409, message: string): never => {
	throw new HTTPException(status, { message });
};
export function classifierApi(
	db: Database,
	options: {
		enabled: boolean;
		admin: boolean;
		actor: string;
		kick?: () => void;
	},
) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (!options.enabled)
			return c.json({ error: "Classifiers are not enabled" }, 503);
		if (
			c.req.method !== "GET" &&
			!c.req.path.includes("/results/") &&
			!options.admin
		)
			return c.json(
				{ error: "Only inbox administrators can configure or run classifiers" },
				403,
			);
		await next();
	});
	app.get("/classifiers", async (c) => {
		await finishRuns(db);
		return c.json(
			await db`SELECT c.*,t.name,t.color,
   (SELECT row_to_json(s) FROM (SELECT r.id,r.status,r.created_at,count(i.*)::int AS total,
     count(*) FILTER(WHERE i.status IN ('complete','review'))::int AS processed,
     count(*) FILTER(WHERE i.status='review')::int AS review,
     count(*) FILTER(WHERE i.status='failed')::int AS failed,
     count(*) FILTER(WHERE i.status='skipped')::int AS skipped
    FROM classifier_runs r JOIN classifier_run_items i ON i.run_id=r.id WHERE r.classifier_id=c.id GROUP BY r.id ORDER BY r.created_at DESC LIMIT 1) s) AS run,
   (SELECT count(*)::int FROM conversation_classifications j WHERE j.classifier_id=c.id AND j.status='error') AS errors
   FROM classifiers c JOIN tags t ON t.id=c.tag_id ORDER BY c.updated_at,c.id`,
		);
	});
	async function save(classifierId: string | null, body: unknown) {
		const data = input.parse(body);
		return db.begin(async (tx) => {
			const [tag] =
				await tx`SELECT name,color FROM tags WHERE id=${data.tag_id}`;
			if (!tag) fail(404, "Tag not found");
			if (data.mailbox_ids.length) {
				const found =
					await tx`SELECT id FROM mailboxes WHERE id IN ${tx(data.mailbox_ids)}`;
				if (found.length !== new Set(data.mailbox_ids).size)
					fail(400, "Unknown mailbox");
			}
			const values = {
				question: data.question,
				tag_id: data.tag_id,
				mailbox_ids: [...new Set(data.mailbox_ids)].sort(),
				enabled: data.enabled,
			};
			if (!classifierId) {
				const [{ count }] =
					await tx`SELECT count(*)::int AS count FROM classifiers`;
				if (count >= 50) fail(400, "A maximum of 50 classifiers is supported");
				const [created] =
					await tx`INSERT INTO classifiers ${tx(values)} RETURNING *`;
				return { ...created, ...tag, run: null };
			}
			const [old] =
				await tx`SELECT * FROM classifiers WHERE id=${classifierId} FOR UPDATE`;
			if (!old) fail(404, "Classifier not found");
			if (data.revision !== old.revision)
				fail(409, "Classifier changed; refresh and try again");
			const changed =
				old.question !== data.question ||
				old.tag_id !== data.tag_id ||
				JSON.stringify([...old.mailbox_ids].sort()) !==
					JSON.stringify(values.mailbox_ids);
			if (changed || !data.enabled || old.enabled !== data.enabled) {
				await tx`UPDATE classifier_runs SET status='cancelled' WHERE classifier_id=${classifierId} AND status='running'`;
				await tx`DELETE FROM conversation_classifications WHERE classifier_id=${classifierId}`;
				await tx`DELETE FROM conversation_tags WHERE tag_id=${old.tag_id} AND source='classifier'`;
			}
			const [updated] =
				await tx`UPDATE classifiers SET ${tx(values)},revision=revision+1,updated_at=now() WHERE id=${classifierId} RETURNING *`;
			// Enabling does not implicitly classify historical mail. Preserve existing jobs on a no-op edit.
			if (!changed && data.enabled)
				await tx`UPDATE conversation_classifications SET revision=${updated.revision},token=gen_random_uuid(),lease_until=NULL WHERE classifier_id=${classifierId}`;
			return { ...updated, ...tag, run: null };
		});
	}
	app.post("/classifiers", async (c) =>
		c.json(await save(null, await c.req.json()), 201),
	);
	app.put("/classifiers/:id", async (c) =>
		c.json(await save(id.parse(c.req.param("id")), await c.req.json())),
	);
	app.post("/classifiers/:id/runs", async (c) => {
		const classifierId = id.parse(c.req.param("id"));
		const data = z
			.object({
				mailbox_ids: z.array(z.string().email()).min(1).max(50),
				selection: z.enum(["unprocessed", "all"]),
				reset: z.boolean().default(false),
				enable: z.boolean().default(false),
			})
			.strict()
			.parse(await c.req.json());
		if (data.reset && data.selection !== "all")
			fail(400, "Choose all conversations to reset corrections");
		const run = await db.begin(async (tx) => {
			const [classifier] =
				await tx`SELECT * FROM classifiers WHERE id=${classifierId} FOR UPDATE`;
			if (!classifier) fail(404, "Classifier not found");
			const [active] =
				await tx`SELECT * FROM classifier_runs WHERE classifier_id=${classifierId} AND status='running'`;
			if (active) return active;
			if (!classifier.enabled && !data.enable)
				fail(400, "Enable this classifier to run it");
			if (
				classifier.mailbox_ids.length &&
				data.mailbox_ids.some((m) => !classifier.mailbox_ids.includes(m))
			)
				fail(400, "Mailboxes must be within classifier scope");
			const targets =
				await tx`SELECT c.mailbox_id,c.thread_id,c.generation FROM conversations c WHERE c.mailbox_id IN ${tx(data.mailbox_ids)} AND classifier_thread_active(c.mailbox_id,c.thread_id)
    AND (${data.selection === "all"} OR NOT EXISTS(SELECT 1 FROM conversation_classifications j WHERE j.classifier_id=${classifierId} AND j.mailbox_id=c.mailbox_id AND j.thread_id=c.thread_id AND j.revision=${classifier.revision} AND j.generation=c.generation AND j.status IN ('complete','review','pending')))
    ORDER BY c.mailbox_id,c.thread_id LIMIT 5001 FOR UPDATE OF c`;
			if (!targets.length) fail(400, "No conversations to process");
			if (targets.length > 5000)
				fail(
					400,
					"This run exceeds 5,000 conversations. Select fewer mailboxes.",
				);
			if (data.enable)
				await tx`UPDATE classifiers SET enabled=true WHERE id=${classifierId}`;
			const [created] =
				await tx`INSERT INTO classifier_runs(classifier_id,revision,actor) VALUES(${classifierId},${classifier.revision},${options.actor}) RETURNING *`;
			await tx`INSERT INTO classifier_run_items(run_id,mailbox_id,thread_id,status)
    SELECT ${created.id},t.mailbox_id,t.thread_id,CASE WHEN EXISTS(SELECT 1 FROM conversation_tags ct WHERE ct.mailbox_id=t.mailbox_id AND ct.thread_id=t.thread_id AND ct.tag_id=${classifier.tag_id} AND ct.source='manual') OR (${!data.reset} AND EXISTS(SELECT 1 FROM conversation_classifications j WHERE j.mailbox_id=t.mailbox_id AND j.thread_id=t.thread_id AND j.classifier_id=${classifierId} AND j.source='human')) THEN 'skipped' ELSE 'pending' END
    FROM jsonb_to_recordset(${tx.json(targets)}) AS t(mailbox_id text,thread_id uuid,generation integer)`;
			await tx`INSERT INTO conversation_classifications(mailbox_id,thread_id,classifier_id,revision,generation,run_id,priority)
    SELECT i.mailbox_id,i.thread_id,${classifierId},${classifier.revision},c.generation,${created.id},1 FROM classifier_run_items i JOIN conversations c USING(mailbox_id,thread_id) WHERE i.run_id=${created.id} AND i.status='pending'
    ON CONFLICT(mailbox_id,thread_id,classifier_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,run_id=excluded.run_id,priority=1,status='pending',token=gen_random_uuid(),answer=NULL,probability=NULL,source='jev',actor=NULL,error=NULL,attempts=0,available_at=now(),lease_until=NULL,updated_at=now()`;
			await tx`DELETE FROM conversation_tags ct USING classifier_run_items i WHERE i.run_id=${created.id} AND i.status='pending' AND ct.mailbox_id=i.mailbox_id AND ct.thread_id=i.thread_id AND ct.tag_id=${classifier.tag_id} AND ct.source='classifier'`;
			return created;
		});
		options.kick?.();
		return c.json(run, 201);
	});
	app.post("/classifiers/:id/cancel", async (c) => {
		const classifierId = id.parse(c.req.param("id"));
		await db.begin(async (tx) => {
			await tx`SELECT id FROM classifiers WHERE id=${classifierId} FOR UPDATE`;
			const runs =
				await tx`UPDATE classifier_runs SET status='cancelled' WHERE classifier_id=${classifierId} AND status='running' RETURNING id`;
			for (const run of runs) {
				await tx`UPDATE conversation_classifications SET status=CASE WHEN priority=0 THEN status ELSE 'skipped' END,run_id=NULL,token=gen_random_uuid(),lease_until=NULL WHERE run_id=${run.id} AND status='pending'`;
				await tx`UPDATE classifier_run_items SET status='skipped' WHERE run_id=${run.id} AND status='pending'`;
			}
		});
		return c.body(null, 204);
	});
	app.get("/results/:mailbox", async (c) => {
		const thread = c.req.query("thread");
		if (thread) id.parse(thread);
		return c.json(
			await db`SELECT j.mailbox_id,j.thread_id,j.classifier_id,j.revision,j.generation,j.token,j.status,j.answer,j.probability,j.source,j.error,c.question,t.name,t.color,t.id AS tag_id FROM conversation_classifications j JOIN classifiers c ON c.id=j.classifier_id JOIN tags t ON t.id=c.tag_id WHERE j.mailbox_id=${c.req.param("mailbox")} AND c.enabled AND j.revision=c.revision AND j.status IN ('review','error') ${thread ? db`AND j.thread_id=${thread}` : db``} AND NOT EXISTS(SELECT 1 FROM conversation_tags ct WHERE ct.mailbox_id=j.mailbox_id AND ct.thread_id=j.thread_id AND ct.tag_id=c.tag_id AND ct.source='manual') ORDER BY j.updated_at DESC LIMIT 1000`,
		);
	});
	app.put("/results/:mailbox/:thread/:classifier", async (c) => {
		const classifierId = id.parse(c.req.param("classifier")),
			thread = id.parse(c.req.param("thread")),
			mailbox = c.req.param("mailbox");
		const data = z
			.object({ answer: z.boolean(), revision: z.number().int(), token: id })
			.strict()
			.parse(await c.req.json());
		await db.begin(async (tx) => {
			const [classifier] =
				await tx`SELECT * FROM classifiers WHERE id=${classifierId} FOR UPDATE`;
			if (!classifier?.enabled || classifier.revision !== data.revision)
				fail(409, "Classifier changed; refresh and try again");
			await tx`SELECT 1 FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${thread} FOR UPDATE`;
			const [row] =
				await tx`UPDATE conversation_classifications SET answer=${data.answer},source='human',actor=${options.actor},status='complete',token=gen_random_uuid(),lease_until=NULL,updated_at=now() WHERE mailbox_id=${mailbox} AND thread_id=${thread} AND classifier_id=${classifierId} AND token=${data.token} RETURNING *`;
			if (!row) fail(409, "Conversation changed; refresh and try again");
			await tx`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at) VALUES(${mailbox},${thread},${classifier.tag_id},'classifier',${options.actor},${data.answer ? null : tx`now()`}) ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET actor=excluded.actor,removed_at=excluded.removed_at,updated_at=now() WHERE conversation_tags.source='classifier'`;
			if (row.run_id)
				await tx`UPDATE classifier_run_items SET status='complete' WHERE run_id=${row.run_id} AND mailbox_id=${mailbox} AND thread_id=${thread} AND status='pending'`;
		});
		return c.body(null, 204);
	});
	return app;
}
