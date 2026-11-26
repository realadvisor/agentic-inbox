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
const activity = `SELECT r.id,r.mailbox_id,r.thread_id,r.subject,r.started_at,r.finished_at,r.duration_ms,CASE WHEN r.status='succeeded' AND (SELECT bool_or(i.disposition='review') FROM classifier_provider_run_items i WHERE i.run_id=r.id) THEN 'review' ELSE r.status END AS status,r.http_status,r.requested_model,r.returned_model,r.request_body,r.response_body,r.error, 'request'::text AS kind, false AS historical,
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
		const requestStatus = db`CASE WHEN r.status='succeeded' AND (SELECT bool_or(i.disposition='review') FROM classifier_provider_run_items i WHERE i.run_id=r.id) THEN 'review' ELSE r.status END`;
		type PageCandidate = {
			id: string;
			cursor_time: string;
			kind: "request" | "attempt";
		};
		const skipRequests =
			f.status === "queued" || f.status === "blocked" || f.status === "skipped";
		const requestStatusFilter =
			f.status === "review"
				? db`AND r.status='succeeded' AND EXISTS(SELECT 1 FROM classifier_provider_run_items i WHERE i.run_id=r.id AND i.disposition='review')`
				: f.status === "succeeded"
					? db`AND r.status='succeeded' AND NOT EXISTS(SELECT 1 FROM classifier_provider_run_items i WHERE i.run_id=r.id AND i.disposition='review')`
					: f.status
						? db`AND r.status=${f.status}`
						: db``;
		// Preserve PostgreSQL microseconds; JS Date would lose precision between pages.
		const requests = skipRequests
			? []
			: await db<PageCandidate[]>`
   SELECT r.id,
    to_char(r.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
    'request'::text AS kind
   FROM classifier_provider_runs r
   WHERE true
    ${f.mailbox ? db`AND r.mailbox_id=${f.mailbox}` : db``}
    ${f.thread ? db`AND r.thread_id=${f.thread}` : db``}
    ${f.from ? db`AND r.started_at>=${f.from}` : db``}
    ${f.to ? db`AND r.started_at<${f.to}` : db``}
    ${cursor ? db`AND r.started_at<=${cursor.time}::text::timestamptz AND (r.started_at,r.id)<(${cursor.time}::text::timestamptz,${cursor.id}::uuid)` : db``}
    ${requestStatusFilter}
    ${f.classifier ? db`AND EXISTS(SELECT 1 FROM classifier_provider_run_items i WHERE i.run_id=r.id AND i.classifier_id=${f.classifier})` : db``}
   ORDER BY r.started_at DESC,r.id DESC
   LIMIT ${f.limit + 1}`;
		// When N+1 requests exist, older attempts cannot enter this page. Pass the
		// (N+1)-th request as a concrete scalar bound so PostgreSQL uses the time index.
		const cutoff = requests.length > f.limit ? requests[f.limit] : undefined;
		const attempts: PageCandidate[] = [];
		let attemptCursor = cursor;
		let batchSize = Math.max(f.limit * 2, 50);
		for (let round = 0; round < 20 && attempts.length < f.limit + 1; round++) {
			const batch = await db<
				{
					id: string;
					cursor_time: string;
					unlinked: boolean;
				}[]
			>`WITH cand AS MATERIALIZED (
    SELECT r.id,r.started_at,
     to_char(r.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
     r.job_token,r.attempt
    FROM classification_attempts r
    WHERE true
     ${f.mailbox ? db`AND r.mailbox_id=${f.mailbox}` : db``}
     ${f.thread ? db`AND r.thread_id=${f.thread}` : db``}
     ${f.from ? db`AND r.started_at>=${f.from}` : db``}
     ${f.to ? db`AND r.started_at<${f.to}` : db``}
     ${f.status ? db`AND r.status=${f.status}` : db``}
     ${f.classifier ? db`AND r.classifier_id=${f.classifier}` : db``}
     ${attemptCursor ? db`AND r.started_at<=${attemptCursor.time}::text::timestamptz AND (r.started_at,r.id)<(${attemptCursor.time}::text::timestamptz,${attemptCursor.id}::uuid)` : db``}
     ${cutoff ? db`AND r.started_at>=${cutoff.cursor_time}::text::timestamptz AND (r.started_at,r.id)>=(${cutoff.cursor_time}::text::timestamptz,${cutoff.id}::uuid)` : db``}
    ORDER BY r.started_at DESC,r.id DESC
    LIMIT ${batchSize}
   )
   SELECT c.id,c.cursor_time,
    NOT EXISTS(SELECT 1 FROM classifier_provider_run_items i WHERE i.job_token=c.job_token AND i.attempt=c.attempt) AS unlinked
   FROM cand c
   ORDER BY c.started_at DESC,c.id DESC`;
			for (const row of batch) {
				if (row.unlinked) {
					attempts.push({
						id: row.id,
						cursor_time: row.cursor_time,
						kind: "attempt",
					});
					if (attempts.length >= f.limit + 1) break;
				}
			}
			if (batch.length < batchSize) break;
			const lastCandidate = batch.at(-1)!;
			attemptCursor = { time: lastCandidate.cursor_time, id: lastCandidate.id };
			batchSize = Math.min(500, batchSize * 2);
		}
		const merged = [...requests, ...attempts].sort((a, b) =>
			a.cursor_time !== b.cursor_time
				? a.cursor_time > b.cursor_time
					? -1
					: 1
				: a.id !== b.id
					? a.id > b.id
						? -1
						: 1
					: 0,
		);
		const page = merged.slice(0, f.limit);
		const last = page.at(-1);
		const next =
			merged.length > f.limit && last
				? JSON.stringify({
						time: last.cursor_time,
						id: last.id,
					})
				: null;
		if (!page.length) return c.json({ runs: [], next_cursor: null });
		const requestIds = page
			.filter((p) => p.kind === "request")
			.map((p) => p.id);
		const attemptIds = page
			.filter((p) => p.kind === "attempt")
			.map((p) => p.id);
		const [requestRows, attemptRows] = await Promise.all([
			requestIds.length
				? db`SELECT r.id,r.mailbox_id,r.thread_id,r.subject,r.started_at,r.finished_at,r.duration_ms,${requestStatus} AS status,r.http_status,coalesce(r.requested_model,'') AS requested_model,r.returned_model,r.error,'request'::text AS kind,false AS historical,(SELECT coalesce(json_agg(json_build_object('classifier_id',i.classifier_id,'name',i.classifier_name,'attempt',i.attempt) ORDER BY i.question_key),'[]'::json) FROM classifier_provider_run_items i WHERE i.run_id=r.id) AS classifiers FROM classifier_provider_runs r WHERE r.id IN ${db(requestIds)}`
				: [],
			attemptIds.length
				? db`SELECT a.id,a.mailbox_id,a.thread_id,a.subject,a.started_at,a.finished_at,NULL::integer AS duration_ms,a.status,NULL::integer AS http_status,'' AS requested_model,NULL::text AS returned_model,a.error,'attempt'::text AS kind,a.historical,json_build_array(json_build_object('classifier_id',a.classifier_id,'name',a.classifier_name,'attempt',a.attempt)) AS classifiers FROM classification_attempts a WHERE a.id IN ${db(attemptIds)}`
				: [],
		]);
		const byKey = new Map<string, Record<string, unknown>>();
		for (const row of requestRows) byKey.set(`request:${row.id}`, row);
		for (const row of attemptRows) byKey.set(`attempt:${row.id}`, row);
		return c.json({
			runs: page
				.map((p) => byKey.get(`${p.kind}:${p.id}`))
				.filter((row): row is Record<string, unknown> => row !== undefined),
			next_cursor: next,
		});
	});
	app.get("/:id", async (c) => {
		let id = z.string().uuid().parse(c.req.param("id"));
		const [handedOff] =
			await db`SELECT run_id FROM classifier_provider_run_items WHERE lifecycle_id=${id} ORDER BY run_id LIMIT 1`;
		if (handedOff) id = handedOff.run_id;
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
				: handedOff
					? [{ id: run.id }]
					: [];
		return c.json({ ...run, items, requests, email: email ?? null });
	});
	return app;
}
