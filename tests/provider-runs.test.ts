import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { processJob } from "../server/classification/queue";
import { providerRunsApi } from "../server/classification/provider-runs-api";
import { pruneProviderRuns } from "../server/classification/provider-runs";

const schema = "test_provider_runs_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db);
const mailbox = "logs@example.test";
const app = providerRunsApi(db, true);
let classifierIds: string[];
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Logs");
	classifierIds = (
		await db`SELECT c.id FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.group_id IS NULL ORDER BY c.id LIMIT 2`
	).map((c) => c.id);
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
async function prepare(count = 1) {
	await db`UPDATE classifiers SET enabled=false`;
	await db`UPDATE classifiers SET enabled=true WHERE id IN ${db(classifierIds.slice(0, count))}`;
	await db`UPDATE classifier_provider_state SET cooldown_until=NULL`;
	const thread = crypto.randomUUID();
	await store.insert(mailbox, {
		id: thread,
		thread_id: thread,
		sender: "customer@example.test",
		recipient: mailbox,
		subject: "Log capture",
		body: "Please help",
		date: new Date(),
	});
	const jobs =
		await db`SELECT * FROM conversation_classifications WHERE thread_id=${thread} ORDER BY classifier_id`;
	return { thread, token: jobs[0].token as string };
}
const yes: typeof fetch = async (_url, init) => {
	const p = JSON.parse(String(init?.body));
	return Response.json({
		model: "jev-test",
		answers: Object.fromEntries(
			Object.keys(p.questions).map((k) => [k, { type: "noul", noul: 0.96 }]),
		),
	});
};

test("one physical request records both batched questions, exact IO, and applied outcomes", async () => {
	const { thread, token } = await prepare(2);
	let body = "";
	let calls = 0;
	await processJob(db, "secret-not-for-logs", token, async (url, init) => {
		calls++;
		body = String(init?.body);
		return yes(url, init);
	});
	assert.equal(calls, 1);
	const runs =
		await db`SELECT * FROM classifier_provider_runs WHERE thread_id=${thread}`;
	assert.equal(runs.length, 1);
	assert.equal(runs[0].request_body, body);
	assert.equal(runs[0].status, "succeeded");
	assert.equal(runs[0].returned_model, "jev-test");
	assert.ok(!JSON.stringify(runs).includes("secret-not-for-logs"));
	const items =
		await db`SELECT * FROM classifier_provider_run_items WHERE run_id=${runs[0].id} ORDER BY question_key`;
	assert.deepEqual(
		items.map((i) => i.question_key),
		["q0", "q1"],
	);
	assert.equal(new Set(items.map((i) => i.classifier_id)).size, 2);
	assert.ok(
		items.every(
			(i) =>
				i.disposition === "applied" &&
				i.probability === 0.96 &&
				i.attempt === 1,
		),
	);
	const detail = await (await app.request("/" + runs[0].id)).json();
	assert.equal(detail.items.length, 2);
	assert.equal(detail.email.id, thread);
});

test("HTTP failure and retry are separate immutable runs", async () => {
	const { thread, token } = await prepare();
	await processJob(
		db,
		"key",
		token,
		async () =>
			new Response("rate limited", {
				status: 429,
				headers: { "Retry-After": "1" },
			}),
	);
	await db`UPDATE conversation_classifications SET available_at=now() WHERE token=${token}`;
	await db`UPDATE classifier_provider_state SET cooldown_until=NULL`;
	await processJob(db, "key", token, yes);
	const runs =
		await db`SELECT r.*,i.attempt,i.disposition FROM classifier_provider_runs r JOIN classifier_provider_run_items i ON i.run_id=r.id WHERE r.thread_id=${thread} ORDER BY r.started_at`;
	assert.equal(runs.length, 2);
	assert.equal(runs[0].response_body, "rate limited");
	assert.equal(runs[0].status, "failed");
	assert.equal(runs[0].disposition, "retry");
	assert.equal(runs[1].attempt, 2);
	assert.equal(runs[1].disposition, "applied");
});

test("malformed JSON, invalid answer, timeout and uncertain answers remain inspectable", async () => {
	for (const [raw, error] of [
		["{broken", "invalid_provider_response"],
		[
			'{"answers":{"match":{"type":"noul","noul":8}}}',
			"invalid_provider_answer",
		],
	]) {
		const { thread, token } = await prepare();
		await processJob(db, "key", token, async () => new Response(raw));
		const [run] =
			await db`SELECT * FROM classifier_provider_runs WHERE thread_id=${thread}`;
		assert.equal(run.response_body, raw);
		assert.equal(run.error, error);
	}
	const timed = await prepare();
	await processJob(db, "key", timed.token, async () => {
		throw new DOMException("timeout", "TimeoutError");
	});
	const [failure] =
		await db`SELECT * FROM classifier_provider_runs WHERE thread_id=${timed.thread}`;
	assert.equal(failure.status, "failed");
	assert.equal(failure.response_body, null);
	const uncertain = await prepare();
	await processJob(db, "key", uncertain.token, async () =>
		Response.json({ answers: { match: { type: "noul", noul: 0.5 } } }),
	);
	const [item] =
		await db`SELECT i.* FROM classifier_provider_run_items i JOIN classifier_provider_runs r ON r.id=i.run_id WHERE r.thread_id=${uncertain.thread}`;
	assert.equal(item.disposition, "review");
	assert.equal(item.answer, null);
});

test("stale answers retain their probability and are marked discarded", async () => {
	const { thread, token } = await prepare();
	await processJob(db, "key", token, async (url, init) => {
		await db`UPDATE emails SET body='Changed during call' WHERE thread_id=${thread}`;
		return yes(url, init);
	});
	const [item] =
		await db`SELECT i.* FROM classifier_provider_run_items i JOIN classifier_provider_runs r ON r.id=i.run_id WHERE r.thread_id=${thread}`;
	assert.equal(item.disposition, "discarded");
	assert.equal(item.probability, 0.96);
});

test("logs are admin-only, paginated without duplicates, and summaries exclude bodies", async () => {
	const denied = providerRunsApi(db, false);
	assert.equal((await denied.request("/")).status, 403);
	const [first] = await db`SELECT id FROM classifier_provider_runs LIMIT 1`;
	assert.equal((await denied.request("/" + first.id)).status, 403);
	// Consecutive microsecond timestamps exercise lossless cursor boundaries.
	const all =
		await db`SELECT id FROM classifier_provider_runs ORDER BY started_at,id`;
	for (const [n, r] of all.entries())
		await db`UPDATE classifier_provider_runs SET started_at='2026-09-24T10:00:00Z'::timestamptz+${n}*interval '1 microsecond' WHERE id=${r.id}`;
	let cursor: string | null = null;
	const seen = new Set<string>();
	do {
		const q = new URLSearchParams({ limit: "2" });
		if (cursor) q.set("cursor", cursor);
		const res = await app.request("/?" + q);
		assert.equal(res.status, 200);
		const page = await res.json();
		for (const run of page.runs) {
			assert.ok(!seen.has(run.id));
			seen.add(run.id);
			assert.equal(run.request_body, undefined);
			assert.equal(run.response_body, undefined);
		}
		cursor = page.next_cursor;
	} while (cursor);
	const [unlogged] =
		await db`SELECT count(*)::int AS count FROM classification_attempts a WHERE NOT EXISTS(SELECT 1 FROM classifier_provider_run_items i WHERE i.job_token=a.job_token AND i.attempt=a.attempt)`;
	assert.equal(seen.size, all.length + unlogged.count);
	const failed = await (await app.request("/?status=failed")).json();
	assert.ok(
		failed.runs.every((r: { status: string }) => r.status === "failed"),
	);
	assert.equal((await app.request("/?cursor=oops")).status, 400);
});

test("retention deletes bodies and items; interrupted application stays explicit", async () => {
	const { thread, token } = await prepare();
	await processJob(db, "key", token, yes);
	const [run] =
		await db`SELECT id FROM classifier_provider_runs WHERE thread_id=${thread}`;
	await db`UPDATE classifier_provider_runs SET started_at=now()-interval '6 minutes',status='running' WHERE id=${run.id}`;
	await db`UPDATE classifier_provider_run_items SET disposition='pending' WHERE run_id=${run.id}`;
	await pruneProviderRuns(db);
	const [updated] =
		await db`SELECT status FROM classifier_provider_runs WHERE id=${run.id}`;
	assert.equal(updated.status, "interrupted");
	const [item] =
		await db`SELECT disposition FROM classifier_provider_run_items WHERE run_id=${run.id}`;
	assert.equal(item.disposition, "failed");
	await db`UPDATE classifier_provider_runs SET started_at=now()-interval '31 days' WHERE id=${run.id}`;
	await pruneProviderRuns(db);
	assert.equal(
		(await db`SELECT id FROM classifier_provider_runs WHERE id=${run.id}`)
			.length,
		0,
	);
	assert.equal(
		(
			await db`SELECT run_id FROM classifier_provider_run_items WHERE run_id=${run.id}`
		).length,
		0,
	);
});

test("provider duration excludes slow result persistence", async () => {
	const { thread, token } = await prepare(2);
	await db.unsafe(
		`CREATE FUNCTION delay_provider_log() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.probability IS NULL AND NEW.probability IS NOT NULL THEN PERFORM pg_sleep(0.15); END IF; RETURN NEW; END; $$`,
	);
	await db.unsafe(
		`CREATE TRIGGER delay_provider_log BEFORE UPDATE ON classifier_provider_run_items FOR EACH ROW EXECUTE FUNCTION delay_provider_log()`,
	);
	try {
		await processJob(db, "fake", token, yes);
		const [run] =
			await db`SELECT duration_ms,extract(epoch FROM (finished_at-started_at))*1000 AS total_ms FROM classifier_provider_runs WHERE thread_id=${thread}`;
		assert.ok(Number(run.total_ms) - run.duration_ms >= 250);
	} finally {
		await db.unsafe(
			`DROP TRIGGER delay_provider_log ON classifier_provider_run_items`,
		);
		await db.unsafe(`DROP FUNCTION delay_provider_log()`);
	}
});

test("HTML-heavy emails classify using readable text and preserve more than 30 messages", async () => {
	const { thread } = await prepare();
	await db`UPDATE emails SET body=${"<style>" + "x".repeat(150000) + "</style><p>Please help</p>"} WHERE thread_id=${thread}`;
	for (let i = 0; i < 31; i++)
		await store.insert(mailbox, {
			id: crypto.randomUUID(),
			thread_id: thread,
			sender: "customer@example.test",
			recipient: mailbox,
			subject: "Follow-up",
			body: `Message ${i}`,
			date: new Date(Date.now() + i + 1),
		});
	const [job] =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${thread}`;
	let messages = 0;
	await processJob(db, "test", job.token, async (url, init) => {
		const p = JSON.parse(String(init?.body));
		messages = p.state.messages.length;
		assert.ok(String(init?.body).length < 28000);
		return yes(url, init);
	});
	assert.equal(messages, 32);
	const [result] =
		await db`SELECT status FROM conversation_classifications WHERE thread_id=${thread}`;
	assert.equal(result.status, "complete");
});

test("recovered batches retain the rejected attempt in the audit trail", async () => {
	const { thread, token } = await prepare(2);
	let calls = 0;
	await processJob(db, "test", token, async (url, init) => {
		calls++;
		if (calls === 1)
			return Response.json(
				{ detail: { error_type: "max_tokens_exceeded" } },
				{ status: 400 },
			);
		return yes(url, init);
	});
	assert.equal(calls, 3);
	const failed =
		await db`SELECT i.disposition,i.error FROM classifier_provider_run_items i JOIN classifier_provider_runs r ON r.id=i.run_id WHERE r.thread_id=${thread} AND r.status='failed'`;
	assert.equal(failed.length, 2);
	for (const row of failed) {
		assert.equal(row.disposition, "failed");
		assert.equal(row.error, "provider_context_limit");
	}
	const results =
		await db`SELECT status FROM conversation_classifications WHERE thread_id=${thread}`;
	assert.ok(results.every((r) => r.status === "complete"));
});

test("queued and blocked attempts appear without a provider call and remain inspectable", async () => {
	const { thread, token } = await prepare();
	const queued = await (
		await app.request(
			"/?" +
				new URLSearchParams({
					thread,
					status: "queued",
					classifier: classifierIds[0],
				}),
		)
	).json();
	assert.equal(queued.runs.length, 1);
	const id = queued.runs[0].id;
	const queuedDetail = await (await app.request("/" + id)).json();
	assert.equal(queuedDetail.request_body, null);
	assert.equal(queuedDetail.kind, "attempt");
	await db`UPDATE emails SET body=${"x".repeat(35000)} WHERE thread_id=${thread}`;
	const [job] =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${thread}`;
	let calls = 0;
	await processJob(db, "fake", job.token, async () => {
		calls++;
		return Response.json({});
	});
	assert.equal(calls, 0);
	const blocked = await (
		await app.request("/?" + new URLSearchParams({ thread, status: "blocked" }))
	).json();
	assert.equal(blocked.runs.length, 1);
	assert.equal(blocked.runs[0].error, "provider_context_limit");
	const detail = await (await app.request("/" + blocked.runs[0].id)).json();
	assert.equal(detail.request_body, null);
	assert.equal(detail.items[0].error, "provider_context_limit");
	// Previous activity survives the new message/token.
	assert.equal((await app.request("/" + id)).status, 200);
	assert.notEqual(token, job.token);
});

test("an attempt links its physical request without duplicating the run list", async () => {
	const { thread, token } = await prepare();
	const before = await (await app.request("/?thread=" + thread)).json();
	const id = before.runs[0].id;
	await processJob(db, "fake", token, yes);
	const after = await (await app.request("/?thread=" + thread)).json();
	assert.equal(after.runs.length, 1);
	assert.equal(after.runs[0].kind, "request");
	const detail = await (await app.request("/" + id)).json();
	assert.equal(detail.status, "succeeded");
	assert.equal(detail.requests.length, 1);
	assert.equal(detail.requests[0].id, after.runs[0].id);
});
