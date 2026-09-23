import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
const id = z.string().uuid();
const input = z.object({
	question: z.string().trim().min(1).max(4000),
	tag_id: id,
	mailbox_ids: z.array(z.string().email()).max(50),
	enabled: z.boolean(),
});
const missing = () => new HTTPException(404, { message: "Not found" });
export function previewApi(db: Database) {
	const app = new Hono();
	app.get("/classifiers", async (c) =>
		c.json(
			await db`SELECT c.*,t.name,t.color,
 (SELECT row_to_json(r) FROM preview_runs r WHERE r.classifier_id=c.id ORDER BY r.created_at DESC LIMIT 1) AS run
 FROM preview_classifiers c JOIN tags t ON t.id=c.tag_id ORDER BY CASE c.fixture_key WHEN 'reply' THEN 0 WHEN 'deletion' THEN 1 WHEN 'access' THEN 2 ELSE 3 END,c.updated_at,c.id`,
		),
	);
	async function save(classifierId: string | null, body: unknown) {
		const data = input.parse(body);
		return db.begin(async (tx) => {
			const [tag] =
				await tx`SELECT name,color FROM tags WHERE id=${data.tag_id}`;
			if (!tag) throw missing();
			if (data.mailbox_ids.length) {
				const found =
					await tx`SELECT id FROM mailboxes WHERE id IN ${tx(data.mailbox_ids)}`;
				if (found.length !== new Set(data.mailbox_ids).size) throw missing();
			}
			if (!classifierId) {
				const [created] =
					await tx`INSERT INTO preview_classifiers ${tx(data)} RETURNING *`;
				return { ...created, ...tag, run: null };
			}
			const [old] =
				await tx`SELECT * FROM preview_classifiers WHERE id=${classifierId} FOR UPDATE`;
			if (!old) throw missing();
			const changed =
				old.question !== data.question ||
				old.tag_id !== data.tag_id ||
				JSON.stringify([...old.mailbox_ids].sort()) !==
					JSON.stringify([...data.mailbox_ids].sort());
			if (changed || !data.enabled) {
				await tx`UPDATE preview_runs SET status='cancelled' WHERE classifier_id=${classifierId} AND status='running'`;
				await tx`DELETE FROM conversation_tags WHERE tag_id=${old.tag_id} AND source='classifier'`;
				await tx`DELETE FROM preview_classifications WHERE classifier_id=${classifierId}`;
			}
			const [updated] =
				await tx`UPDATE preview_classifiers SET ${tx(data)},revision=revision+${changed ? 1 : 0},updated_at=now() WHERE id=${classifierId} RETURNING *`;
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
				mailbox_ids: z.array(z.string().email()).min(1),
				selection: z.enum(["unprocessed", "all"]),
				reset: z.boolean().default(false),
				enable: z.boolean().default(false),
			})
			.parse(await c.req.json());
		return c.json(
			await db.begin(async (tx) => {
				const [classifier] =
					await tx`SELECT * FROM preview_classifiers WHERE id=${classifierId} FOR UPDATE`;
				if (!classifier) throw missing();
				const [active] =
					await tx`SELECT * FROM preview_runs WHERE classifier_id=${classifierId} AND status='running'`;
				if (active) return active;
				if (!classifier.enabled && !data.enable)
					throw new HTTPException(400, {
						message: "Enable this classifier to run it.",
					});
				if (
					classifier.mailbox_ids.length &&
					data.mailbox_ids.some((m) => !classifier.mailbox_ids.includes(m))
				)
					throw new HTTPException(400, {
						message: "Mailboxes must be within classifier scope.",
					});
				const targets =
					await tx`SELECT c.mailbox_id,c.thread_id FROM conversations c
    WHERE c.mailbox_id IN ${tx(data.mailbox_ids)} AND EXISTS(SELECT 1 FROM emails e WHERE e.mailbox_id=c.mailbox_id AND e.thread_id=c.thread_id AND e.delivery_status='received' AND e.folder_id NOT IN ('archive','trash','spam'))
    AND (${data.selection === "all"} OR NOT EXISTS(SELECT 1 FROM preview_classifications r WHERE r.classifier_id=${classifierId} AND r.mailbox_id=c.mailbox_id AND r.thread_id=c.thread_id AND r.revision=${classifier.revision})) ORDER BY c.mailbox_id,c.thread_id`;
				if (!targets.length)
					throw new HTTPException(400, {
						message: "No conversations to process.",
					});
				if (data.enable)
					await tx`UPDATE preview_classifiers SET enabled=true WHERE id=${classifierId}`;
				if (data.reset)
					for (const target of targets)
						await tx`DELETE FROM preview_classifications WHERE classifier_id=${classifierId} AND mailbox_id=${target.mailbox_id} AND thread_id=${target.thread_id} AND source='human'`;
				const [run] =
					await tx`INSERT INTO preview_runs(classifier_id,targets,total) VALUES(${classifierId},${tx.json(targets)},${targets.length}) RETURNING *`;
				return run;
			}),
			201,
		);
	});
	app.post("/classifiers/:id/cancel", async (c) => {
		const classifierId = id.parse(c.req.param("id"));
		await db.begin(async (tx) => {
			await tx`SELECT id FROM preview_classifiers WHERE id=${classifierId} FOR UPDATE`;
			await tx`UPDATE preview_runs SET status='cancelled' WHERE classifier_id=${classifierId} AND status='running'`;
		});
		return c.body(null, 204);
	});
	app.get("/results/:mailbox", async (c) =>
		c.json(
			await db`SELECT r.*,c.question,t.name,t.color,t.id AS tag_id FROM preview_classifications r JOIN preview_classifiers c ON c.id=r.classifier_id JOIN tags t ON t.id=c.tag_id
 WHERE r.mailbox_id=${c.req.param("mailbox")} AND c.enabled AND NOT EXISTS(SELECT 1 FROM conversation_tags ct WHERE ct.mailbox_id=r.mailbox_id AND ct.thread_id=r.thread_id AND ct.tag_id=c.tag_id AND ct.source='manual')`,
		),
	);
	app.put("/results/:mailbox/:thread/:classifier", async (c) => {
		const data = z
			.object({ answer: z.boolean(), revision: z.number().int() })
			.parse(await c.req.json());
		const classifierId = id.parse(c.req.param("classifier")),
			thread = id.parse(c.req.param("thread")),
			mailbox = c.req.param("mailbox");
		await db.begin(async (tx) => {
			const [classifier] =
				await tx`SELECT * FROM preview_classifiers WHERE id=${classifierId} FOR UPDATE`;
			if (!classifier) throw missing();
			if (classifier.revision !== data.revision || !classifier.enabled)
				throw new HTTPException(409, {
					message: "Classifier changed; refresh and try again.",
				});
			const [row] =
				await tx`UPDATE preview_classifications SET answer=${data.answer},source='human',updated_at=now() WHERE mailbox_id=${mailbox} AND thread_id=${thread} AND classifier_id=${classifierId} RETURNING *`;
			if (!row) throw missing();
			await tx`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at) VALUES(${mailbox},${thread},${classifier.tag_id},'classifier','local-preview-review',${data.answer ? null : tx`now()`}) ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET removed_at=excluded.removed_at,updated_at=now() WHERE conversation_tags.source='classifier'`;
		});
		return c.body(null, 204);
	});
	return app;
}
/** Local fixture driver, deliberately no network/model calls. Edits and unknown questions require review. */
export async function tickPreview(db: Database) {
	await db.begin(async (tx) => {
		const [classifier] =
			await tx`SELECT c.* FROM preview_classifiers c WHERE c.enabled AND EXISTS(SELECT 1 FROM preview_runs r WHERE r.classifier_id=c.id AND r.status='running') ORDER BY c.updated_at FOR UPDATE SKIP LOCKED LIMIT 1`;
		if (!classifier) return;
		const [run] =
			await tx`SELECT * FROM preview_runs WHERE classifier_id=${classifier.id} AND status='running' FOR UPDATE`;
		if (!run) return;
		const target = run.targets[run.processed + run.skipped];
		if (!target) {
			await tx`UPDATE preview_runs SET status='completed' WHERE id=${run.id}`;
			return;
		}
		const [existing] =
			await tx`SELECT * FROM preview_classifications WHERE classifier_id=${classifier.id} AND mailbox_id=${target.mailbox_id} AND thread_id=${target.thread_id}`;
		const [manual] =
			await tx`SELECT 1 FROM conversation_tags WHERE tag_id=${classifier.tag_id} AND mailbox_id=${target.mailbox_id} AND thread_id=${target.thread_id} AND source='manual'`;
		let skipped = !!manual || existing?.source === "human";
		const [active] =
			await tx`SELECT 1 FROM emails WHERE mailbox_id=${target.mailbox_id} AND thread_id=${target.thread_id} AND delivery_status='received' AND folder_id NOT IN ('spam','trash','archive') LIMIT 1`;
		skipped = skipped || !active;
		let answer: boolean | null = null;
		if (!skipped) {
			const [fixture] =
				await tx`SELECT answers FROM preview_fixtures WHERE mailbox_id=${target.mailbox_id} AND thread_id=${target.thread_id}`;
			answer =
				classifier.question === classifier.fixture_question
					? (fixture?.answers[classifier.fixture_key] ?? null)
					: null;
			await tx`INSERT INTO preview_classifications(mailbox_id,thread_id,classifier_id,revision,answer) VALUES(${target.mailbox_id},${target.thread_id},${classifier.id},${classifier.revision},${answer}) ON CONFLICT(mailbox_id,thread_id,classifier_id) DO UPDATE SET revision=excluded.revision,answer=excluded.answer,source='fixture',updated_at=now()`;
			await tx`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at) VALUES(${target.mailbox_id},${target.thread_id},${classifier.tag_id},'classifier','synthetic-fixture',${answer === true ? null : tx`now()`}) ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET removed_at=excluded.removed_at,updated_at=now() WHERE conversation_tags.source='classifier'`;
		}
		await tx`UPDATE preview_runs SET processed=processed+${skipped ? 0 : 1},skipped=skipped+${skipped ? 1 : 0},review=review+${!skipped && answer === null ? 1 : 0},status=CASE WHEN processed+skipped+1>=total THEN 'completed' ELSE 'running' END WHERE id=${run.id}`;
	});
}
