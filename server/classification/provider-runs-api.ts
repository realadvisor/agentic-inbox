import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db";

const filters = z.object({
	mailbox: z.string().email().optional(),
	thread: z.string().uuid().optional(),
	classifier: z.string().uuid().optional(),
	status: z
		.enum([
			"running",
			"succeeded",
			"failed",
			"interrupted",
			"queued",
			"review",
			"blocked",
			"skipped",
		])
		.optional(),
	from: z.string().datetime().optional(),
	to: z.string().datetime().optional(),
	limit: z.coerce.number().int().min(1).max(100).default(25),
	cursor: z.string().max(200).optional(),
});
// Request logs remain the detailed record when present. Lifecycle rows fill the
// gaps without duplicating batched questions or inventing provider requests.
const activity = `SELECT r.id,r.mailbox_id,r.thread_id,r.subject,r.started_at,r.finished_at,r.duration_ms,CASE WHEN r.status='succeeded' AND EXISTS(SELECT 1 FROM classifier_provider_run_items i WHERE i.run_id=r.id AND i.disposition='review') THEN 'review' ELSE r.status END AS status,r.http_status,r.requested_model,r.returned_model,r.request_body,r.response_body,r.error, 'request'::text AS kind, false AS historical,
 (SELECT coalesce(json_agg(json_build_object('classifier_id',i.classifier_id,'name',i.classifier_name,'attempt',i.attempt) ORDER BY i.question_key),'[]'::json) FROM classifier_provider_run_items i WHERE i.run_id=r.id) AS classifiers
 FROM classifier_provider_runs r
 UNION ALL
 SELECT a.id,a.mailbox_id,a.thread_id,a.subject,a.started_at,a.finished_at,NULL::integer AS duration_ms,a.status,NULL::integer AS http_status,'' AS requested_model,NULL::text AS returned_model,NULL::text AS request_body,NULL::text AS response_body,a.error,'attempt' AS kind,a.historical,
 json_build_array(json_build_object('classifier_id',a.classifier_id,'name',a.classifier_name,'attempt',a.attempt)) AS classifiers
 FROM classification_attempts a`;
export function providerRunsApi(db: Database, admin: boolean) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		if (!admin)
			return c.json(
				{ error: "Only inbox administrators can view classifier logs" },
				403,
			);
		await next();
	});
	app.get("/", async (c) => {
		const f = filters.parse(c.req.query());
		let cursor: { time: string; id: string } | undefined;
		if (f.cursor) {
			try {
				cursor = z
					.object({
						time: z.string().datetime({ offset: true }),
						id: z.string().uuid(),
					})
					.parse(JSON.parse(f.cursor));
			} catch {
				return c.json({ error: "Invalid cursor" }, 400);
			}
		}
		const rows =
			await db`WITH activity AS (${db.unsafe(activity)}) SELECT r.id,r.mailbox_id,r.thread_id,r.subject,r.started_at,to_char(r.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,r.finished_at,r.duration_ms,r.status,r.http_status,r.requested_model,r.returned_model,r.error,r.kind,r.historical,r.classifiers
   FROM activity r WHERE (r.kind='request' OR NOT EXISTS(SELECT 1 FROM classification_attempts a JOIN classifier_provider_run_items i ON i.job_token=a.job_token AND i.attempt=a.attempt WHERE a.id=r.id))
   ${f.mailbox ? db`AND r.mailbox_id=${f.mailbox}` : db``}
   ${f.thread ? db`AND r.thread_id=${f.thread}` : db``}
   ${f.status ? db`AND r.status=${f.status}` : db``}
   ${f.from ? db`AND r.started_at>=${f.from}` : db``}
   ${f.to ? db`AND r.started_at<${f.to}` : db``}
   ${f.classifier ? db`AND EXISTS(SELECT 1 FROM json_array_elements(r.classifiers) c WHERE c->>'classifier_id'=${f.classifier})` : db``}
   ${cursor ? db`AND (r.started_at,r.id)<(${cursor.time}::text::timestamptz,${cursor.id}::uuid)` : db``}
   ORDER BY r.started_at DESC,r.id DESC LIMIT ${f.limit + 1}`;
		const items = rows.slice(0, f.limit);
		const last = items.at(-1);
		// Preserve PostgreSQL microseconds; JS Date would lose precision between pages.
		const next =
			rows.length > f.limit && last
				? JSON.stringify({
						time: last.cursor_time,
						id: last.id,
					})
				: null;
		return c.json({
			runs: items.map(({ cursor_time: _cursorTime, ...row }) => row),
			next_cursor: next,
		});
	});
	app.get("/:id", async (c) => {
		const id = z.string().uuid().parse(c.req.param("id"));
		const [run] =
			await db`WITH activity AS (${db.unsafe(activity)}) SELECT * FROM activity WHERE id=${id}`;
		if (!run) return c.json({ error: "Classifier run not found" }, 404);
		const items =
			run.kind === "attempt"
				? await db`SELECT classifier_id,classifier_name,question,revision,generation,job_token,attempt,probability,answer,error,'match' AS question_key,CASE WHEN status='succeeded' THEN 'applied' WHEN status IN ('review','blocked') THEN 'review' WHEN status='skipped' THEN 'discarded' WHEN status='failed' THEN 'failed' ELSE 'pending' END AS disposition FROM classification_attempts WHERE id=${id}`
				: await db`SELECT * FROM classifier_provider_run_items WHERE run_id=${id} ORDER BY question_key`;
		const [email] =
			await db`SELECT id,folder_id FROM emails WHERE mailbox_id=${run.mailbox_id} AND thread_id=${run.thread_id} ORDER BY date DESC,id DESC LIMIT 1`;
		const requests =
			run.kind === "attempt"
				? await db`SELECT DISTINCT i.run_id AS id FROM classifier_provider_run_items i JOIN classification_attempts a ON a.job_token=i.job_token AND a.attempt=i.attempt WHERE a.id=${id}`
				: [];
		return c.json({ ...run, items, requests, email: email ?? null });
	});
	return app;
}
