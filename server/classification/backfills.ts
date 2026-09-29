import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
import type postgres from "postgres";
import { finishRuns } from "./queue";

type Sql = Database | postgres.TransactionSql;
export const backfillInput = z
	.object({
		classifier_ids: z.array(z.string().uuid()).min(1).max(50),
		mailbox_ids: z.array(z.string().email()).min(1).max(50),
		selection: z.enum(["unprocessed", "all"]).default("unprocessed"),
		reset: z.boolean().default(false),
		include_archived: z.boolean().default(true),
		received_from: z.string().datetime().optional(),
		received_before: z.string().datetime().optional(),
		limit: z.number().int().min(1).max(250000).optional(),
	})
	.strict()
	.superRefine((v, c) => {
		if (
			v.received_from &&
			v.received_before &&
			v.received_from >= v.received_before
		)
			c.addIssue({
				code: "custom",
				message: "The end date must follow the start date",
			});
		if (v.reset && v.selection !== "all")
			c.addIssue({
				code: "custom",
				message: "Choose force reprocessing to reset corrections",
			});
	});
type Input = z.infer<typeof backfillInput>;
function targets(sql: Sql, data: Input, cutoff?: string) {
	return sql`SELECT c.mailbox_id,c.thread_id,c.generation,max(e.date) AS received_at
 FROM conversations c JOIN emails e ON e.mailbox_id=c.mailbox_id AND e.thread_id=c.thread_id
 WHERE c.mailbox_id IN ${sql(data.mailbox_ids)} AND e.delivery_status='received' AND e.folder_id NOT IN ('spam','trash')
 ${data.include_archived ? sql`` : sql`AND e.folder_id<>'archive'`}
 ${cutoff ? sql`AND c.created_at<=(SELECT created_at FROM classifier_runs WHERE id=${cutoff})` : sql``}
 GROUP BY c.mailbox_id,c.thread_id,c.generation
 HAVING true ${data.received_from ? sql`AND max(e.date)>=${data.received_from}::timestamptz` : sql``}
 ${data.received_before ? sql`AND max(e.date)<${data.received_before}::timestamptz` : sql``}
 ORDER BY max(e.date) DESC,c.mailbox_id,c.thread_id ${data.limit ? sql`LIMIT ${data.limit}` : sql``}`;
}
async function validateScope(sql: Sql, input: Input, lock = false) {
	const ids = [...new Set(input.classifier_ids)].sort();
	const classifiers =
		await sql`SELECT c.*,to_json(c.mailbox_ids) AS mailbox_ids FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE c.id IN ${sql(ids)} AND t.archived_at IS NULL ORDER BY c.id ${lock ? sql`FOR UPDATE OF c` : sql``}`;
	if (classifiers.length !== ids.length)
		throw new HTTPException(404, { message: "Classifier not found" });
	const mailboxes =
		await sql`SELECT id FROM mailboxes WHERE id IN ${sql(input.mailbox_ids)}`;
	if (mailboxes.length !== new Set(input.mailbox_ids).size)
		throw new HTTPException(400, { message: "Unknown mailbox" });
	if (
		classifiers.some(
			(c) =>
				c.mailbox_ids.length &&
				input.mailbox_ids.some((m) => !c.mailbox_ids.includes(m)),
		)
	)
		throw new HTTPException(400, {
			message: "Mailboxes must be within classifier scope",
		});
	return classifiers;
}
export function backfillsApi(
	db: Database,
	kick?: () => void,
	actor = "backfill",
) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.post("/preview", async (c) => {
		const input = backfillInput.parse(await c.req.json());
		await validateScope(db, input);
		const [count] =
			await db`SELECT count(*)::int AS total FROM (${targets(db, input)}) t`;
		return c.json({ count: count.total });
	});
	app.post("/", async (c) => {
		const input = backfillInput.parse(await c.req.json());
		const runs = await db.begin(async (tx) => {
			const classifiers = await validateScope(tx, input, true);
			const active =
				await tx`SELECT id FROM classifier_runs WHERE classifier_id IN ${tx(classifiers.map((c) => c.id))} AND status='running'`;
			if (active.length)
				throw new HTTPException(409, {
					message:
						"A selected classifier already has a run. View its progress or cancel it first.",
				});
			const batch = crypto.randomUUID();
			return tx`INSERT INTO classifier_runs ${tx(classifiers.map((c) => ({ classifier_id: c.id, revision: c.revision, actor, prepared: false, batch_id: batch, request: tx.json(input) })))} RETURNING id,batch_id,status,prepared`;
		});
		kick?.();
		return c.json(runs, 202);
	});
	app.get("/", async (c) => {
		const mailbox = c.req.query("mailbox");
		const rows =
			await db`WITH recent AS MATERIALIZED (SELECT r.*,t.name FROM classifier_runs r JOIN classifiers c ON c.id=r.classifier_id JOIN tags t ON t.id=c.tag_id WHERE r.request IS NOT NULL AND (r.status='running' OR r.batch_id IN (SELECT batch_id FROM classifier_runs WHERE request IS NOT NULL GROUP BY batch_id ORDER BY max(created_at) DESC LIMIT 10)) ${mailbox ? db`AND r.request->'mailbox_ids' ? ${mailbox}` : db``} ORDER BY r.created_at DESC,r.id)
   SELECT r.id,r.batch_id,r.classifier_id,r.name,r.status,r.revision,r.created_at,r.last_progress_at,r.prepared,r.request,counts.*
   FROM recent r CROSS JOIN LATERAL (
    SELECT count(*)::int AS total,count(*) FILTER(WHERE i.status IN ('complete','review'))::int AS processed,
    count(*) FILTER(WHERE i.status='pending')::int AS pending,count(*) FILTER(WHERE i.status='pending' AND NOT i.enqueued)::int AS waiting,
    count(*) FILTER(WHERE i.status='review')::int AS review,count(*) FILTER(WHERE i.status='failed')::int AS failed,
    count(*) FILTER(WHERE i.status='skipped')::int AS skipped,count(*) FILTER(WHERE i.cached)::int AS reused,
    count(*) FILTER(WHERE i.skip_reason='current')::int AS unchanged
    FROM classifier_run_items i WHERE i.run_id=r.id
   ) counts ORDER BY r.created_at DESC,r.id`;
		return c.json(rows);
	});
	return app;
}

/** Durable preparation and bounded admission. Called by the server dispatcher, never the browser.
 * Lock classifiers before runs/conversations, matching configuration writers and consumers. */
export async function advanceBackfills(db: Database) {
	const [candidate] =
		await db`SELECT id,classifier_id,prepared FROM classifier_runs WHERE status='running' AND request IS NOT NULL ORDER BY last_dispatch_at,id LIMIT 1`;
	if (!candidate) return false;
	// Commit the snapshot before locking conversations. Ingestion locks a
	// conversation before reconciling its run, so holding the run row first
	// would invert that lock order.
	if (!candidate.prepared)
		await db.begin(async (tx) => {
			const [classifier] =
				await tx`SELECT revision FROM classifiers WHERE id=${candidate.classifier_id} FOR UPDATE`;
			const [run] =
				await tx`SELECT * FROM classifier_runs WHERE id=${candidate.id} AND status='running'`;
			if (!run || run.prepared || classifier?.revision !== run.revision) return;
			const input = backfillInput.parse(run.request);
			await tx`INSERT INTO classifier_run_items(run_id,mailbox_id,thread_id,enqueued) SELECT ${run.id},mailbox_id,thread_id,false FROM (${targets(tx, input, run.id)}) t ON CONFLICT DO NOTHING`;
			await tx`UPDATE classifier_runs SET prepared=true,last_progress_at=now() WHERE id=${run.id}`;
		});
	let advanced = false;
	await db.begin(async (tx) => {
		const [classifier] =
			await tx`SELECT * FROM classifiers WHERE id=${candidate.classifier_id} FOR UPDATE`;
		const [run] =
			await tx`SELECT * FROM classifier_runs WHERE id=${candidate.id} AND status='running'`;
		if (!run) return;
		if (!classifier || classifier.revision !== run.revision) {
			await tx`UPDATE classifier_runs SET status='cancelled',last_progress_at=now() WHERE id=${run.id}`;
			await tx`UPDATE classifier_run_items SET status='skipped',skip_reason='configuration_changed' WHERE run_id=${run.id} AND status='pending'`;
			return;
		}
		const input = backfillInput.parse(run.request);

		const [{ n }] =
			await tx`SELECT count(*)::int AS n FROM classifier_run_items WHERE run_id=${run.id} AND status='pending' AND enqueued`;
		if (n < 500) {
			const waiting =
				await tx`SELECT i.mailbox_id,i.thread_id FROM classifier_run_items i WHERE i.run_id=${run.id} AND i.status='pending' AND NOT i.enqueued ORDER BY i.mailbox_id,i.thread_id LIMIT ${Math.min(100, 500 - n)}`;
			if (waiting.length) {
				advanced = true;
				await tx`SELECT c.thread_id FROM conversations c JOIN jsonb_to_recordset(${tx.json(waiting)}) AS w(mailbox_id text,thread_id uuid) USING(mailbox_id,thread_id) ORDER BY c.mailbox_id,c.thread_id FOR UPDATE OF c`;
				const plan =
					await tx`WITH config AS MATERIALIZED (SELECT m.mailbox_id,classifier_config_key(${run.classifier_id},m.mailbox_id) AS key FROM (SELECT DISTINCT mailbox_id FROM jsonb_to_recordset(${tx.json(waiting)}) AS w(mailbox_id text)) m)
 SELECT w.*,c.generation,
      CASE WHEN c.thread_id IS NULL OR NOT EXISTS(SELECT 1 FROM emails e WHERE e.mailbox_id=w.mailbox_id AND e.thread_id=w.thread_id AND e.delivery_status='received' AND e.folder_id NOT IN ('spam','trash') ${input.include_archived ? tx`` : tx`AND e.folder_id<>'archive'`}) THEN 'ineligible'
      WHEN tag_manually_overridden(w.mailbox_id,w.thread_id,${classifier.tag_id}) OR (${!input.reset} AND j.source IN ('human','agent')) THEN 'manual'
      WHEN j.revision=${run.revision} AND j.generation=c.generation AND j.status='pending' THEN 'pending'
      WHEN j.revision=${run.revision} AND j.generation=c.generation AND j.evaluation_key=config.key AND j.status IN ('complete','review') AND j.error IS NULL AND ${input.selection === "unprocessed"} THEN 'current' ELSE NULL END AS reason
      FROM jsonb_to_recordset(${tx.json(waiting)}) AS w(mailbox_id text,thread_id uuid)
      JOIN config ON config.mailbox_id=w.mailbox_id
      LEFT JOIN conversations c ON c.mailbox_id=w.mailbox_id AND c.thread_id=w.thread_id
      LEFT JOIN conversation_classifications j ON j.mailbox_id=w.mailbox_id AND j.thread_id=w.thread_id AND j.classifier_id=${run.classifier_id}`;
				const fresh = plan.filter((p) => !p.reason);
				if (fresh.length)
					await tx`INSERT INTO conversation_classifications(mailbox_id,thread_id,classifier_id,revision,generation,run_id,priority)
      SELECT p.mailbox_id,p.thread_id,${run.classifier_id},${run.revision},p.generation,${run.id},2 FROM jsonb_to_recordset(${tx.json(fresh)}) AS p(mailbox_id text,thread_id uuid,generation int)
      ON CONFLICT(mailbox_id,thread_id,classifier_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,run_id=excluded.run_id,priority=2,status='pending',token=gen_random_uuid(),answer=NULL,probability=NULL,source='jev',actor=NULL,error=NULL,attempts=0,available_at=now(),lease_until=NULL,lease_id=NULL,cache_hit=false,updated_at=now()`;
				await tx`UPDATE conversation_classifications j SET run_id=${run.id},priority=2 FROM jsonb_to_recordset(${tx.json(plan)}) AS p(mailbox_id text,thread_id uuid,reason text) WHERE j.classifier_id=${run.classifier_id} AND j.mailbox_id=p.mailbox_id AND j.thread_id=p.thread_id AND p.reason='pending'`;
				await tx`UPDATE classifier_run_items i SET enqueued=(p.reason IS NULL OR p.reason='pending'),status=CASE WHEN p.reason IS NULL OR p.reason='pending' THEN 'pending' ELSE 'skipped' END,skip_reason=nullif(p.reason,'pending') FROM jsonb_to_recordset(${tx.json(plan)}) AS p(mailbox_id text,thread_id uuid,reason text) WHERE i.run_id=${run.id} AND i.mailbox_id=p.mailbox_id AND i.thread_id=p.thread_id`;
			}
		}
		await tx`UPDATE classifier_runs SET last_dispatch_at=now(),last_progress_at=CASE WHEN ${advanced} THEN now() ELSE last_progress_at END WHERE id=${run.id}`;
	});
	await finishRuns(db);
	return advanced;
}
