import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { createApi } from "../server/api";
import { InboxStore } from "../server/store";
import { processJob } from "../server/classification/queue";
const schema = "test_rerun_" + crypto.randomUUID().replaceAll("-", ""),
	admin = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db),
	mailbox = "rerun@example.test";
let classifier: { id: string; tag_id: string };
let kicks = 0;
const app = createApi(db, {
	readAttachment: async () => null,
	classifiersEnabled: true,
	kickClassifiers: () => {
		kicks++;
	},
});
function call(thread: string, method = "POST", target = app) {
	return target.request(
		"http://127.0.0.1:4311/api/v1/classification/threads/" +
			mailbox +
			"/" +
			thread +
			(method === "POST" ? "/rerun" : ""),
		{ method, headers: { "Content-Type": "application/json" } },
	);
}
async function message(folder = "inbox") {
	const e = await store.insert(mailbox, {
		sender: "a@example.test",
		recipient: mailbox,
		subject: "Rerun fixture",
		body: "Please help.",
		folder_id: folder,
	});
	return e!.thread_id!;
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Rerun");
	await db`UPDATE classifiers SET mailbox_ids=ARRAY['other@example.test']`;
	[classifier] =
		await db`UPDATE classifiers SET enabled=true,mailbox_ids=ARRAY[]::text[] WHERE tag_id IN (SELECT id FROM tags WHERE name='Needs reply') RETURNING id,tag_id`;
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
test("explicit reruns replace completed work, reuse pending jobs and apply results to archived threads", async () => {
	const thread = await message("archive");
	const r = await call(thread);
	assert.equal(r.status, 202);
	assert.equal((await r.json()).queued, 1);
	const [job] =
		await db`SELECT * FROM conversation_classifications WHERE thread_id=${thread}`;
	assert.equal(job.priority, 2);
	assert.equal(
		(await db`SELECT * FROM classifier_outbox WHERE job_token=${job.token}`)
			.length,
		1,
	);
	await call(thread);
	const [same] =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${thread}`;
	assert.equal(same.token, job.token);
	let calls = 0;
	await processJob(db, "fake", job.token, async () => {
		calls++;
		return Response.json({ answers: { match: { type: "noul", noul: 0.97 } } });
	});
	assert.equal(calls, 1);
	assert.equal(
		(
			await db`SELECT * FROM conversation_tags WHERE thread_id=${thread} AND removed_at IS NULL`
		).length,
		1,
	);
	const status = await (await call(thread, "GET")).json();
	assert.equal(status.complete, 1);
	assert.equal(status.pending, 0);
	await call(thread);
	const [next] =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${thread}`;
	assert.notEqual(next.token, job.token);
	assert.equal(kicks, 3);
});
test("reruns preserve manual assignments and human review answers", async () => {
	const thread = await message();
	await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor) VALUES(${mailbox},${thread},${classifier.tag_id},'manual','test')`;
	const r = await (await call(thread)).json();
	assert.equal(r.queued, 0);
	assert.equal(r.protected, 1);
	const human = await message();
	await db`UPDATE conversation_classifications SET status='complete',source='human',answer=false WHERE thread_id=${human}`;
	assert.equal((await (await call(human)).json()).protected, 1);
	const [saved] =
		await db`SELECT source,answer FROM conversation_classifications WHERE thread_id=${human}`;
	assert.equal(saved.source, "human");
	assert.equal(saved.answer, false);
});
test("reruns enforce admin access, classifier scope and eligible message state", async () => {
	const thread = await message();
	const member = createApi(db, {
		readAttachment: async () => null,
		classifiersEnabled: true,
		mode: "live",
		actor: "member@example.test",
		mailboxAdmins: ["admin@example.test"],
	});
	assert.equal((await call(thread, "POST", member)).status, 403);
	assert.equal((await call(thread, "GET", member)).status, 403);
	assert.equal((await call(crypto.randomUUID())).status, 404);
	assert.equal((await call(await message("trash"))).status, 400);
	await db`UPDATE classifiers SET mailbox_ids=ARRAY['elsewhere@example.test'] WHERE id=${classifier.id}`;
	assert.equal((await call(thread)).status, 400);
});

test("explicit rerun batches disabled groups and standalone questions and publishes all jobs", async () => {
	await db`UPDATE classifiers SET mailbox_ids=ARRAY[]::text[],enabled=false`;
	const thread = await message();
	const result = await (await call(thread)).json();
	const classifiers = await db`SELECT id FROM classifiers`;
	assert.equal(result.queued, classifiers.length);
	const { publishOutbox } = await import("../server/classification/dispatch");
	const published: string[] = [];
	const queue = {
		sendBatch: async (
			messages: {
				body: import("../server/classification/dispatch").WorkMessage;
			}[],
		) => {
			published.push(
				...messages.flatMap((m) =>
					m.body.version === 1 ? [m.body.token] : m.body.tokens,
				),
			);
		},
	};
	await publishOutbox(db, { live: queue, backfill: queue });
	const jobs =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${thread}`;
	assert.ok(jobs.every((j) => published.includes(j.token)));
	let calls = 0;
	await processJob(db, "fake", jobs[0].token, async (_url, init) => {
		calls++;
		const request = JSON.parse(String(init?.body));
		const questions = Object.values(request.questions) as {
			type: string;
			criteria: Record<string, unknown>;
		}[];
		assert.equal(questions.filter((q) => q.type === "choice").length, 2);
		assert.ok(questions.some((q) => q.type === "noul"));
		return Response.json({
			answers: Object.fromEntries(
				Object.entries(request.questions).map(([key, value]) => {
					const q = value as {
						type: string;
						criteria: Record<string, unknown>;
					};
					if (q.type === "noul") return [key, { type: "noul", noul: 0.5 }];
					const keys = Object.keys(q.criteria);
					return [
						key,
						{
							type: "choice",
							choice: keys[0],
							confidence: 0.2,
							probabilities: Object.fromEntries(
								keys.map((k) => [k, 1 / keys.length]),
							),
						},
					];
				}),
			),
		});
	});
	assert.equal(calls, 1);
	const status = await (await call(thread, "GET")).json();
	assert.equal(status.pending, 0);
	assert.equal(status.review, classifiers.length);
	const reviews = await (
		await app.request(
			`http://127.0.0.1:4311/api/v1/classification/results/${mailbox}?thread=${thread}`,
		)
	).json();
	assert.equal(reviews.length, classifiers.length);
	const row = reviews[0];
	const response = await app.request(
		`http://127.0.0.1:4311/api/v1/classification/results/${mailbox}/${thread}/${row.classifier_id}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				answer: true,
				revision: row.revision,
				token: row.token,
			}),
		},
	);
	assert.equal(response.status, 204);
	assert.ok(
		(await store.list(mailbox, { needs_review: "true" })).emails.some(
			(e) => e.thread_id === thread,
		),
	);
});

test("manual and queue delivery share leases and prepare the conversation once", async () => {
	const thread = await message();
	await call(thread);
	const jobs =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${thread} AND status='pending'`;
	let preparations = 0,
		calls = 0;
	const debug = db.options.debug;
	db.options.debug = (_connection, query) => {
		if (query.includes('sender AS "from"')) preparations++;
	};
	let started!: () => void, release!: () => void;
	const ready = new Promise<void>((r) => {
		started = r;
	});
	const gate = new Promise<void>((r) => {
		release = r;
	});
	try {
		const direct = processJob(db, "test", jobs[0].token, async (_url, init) => {
			calls++;
			started();
			await gate;
			const p = JSON.parse(String(init?.body));
			return Response.json({
				answers: Object.fromEntries(
					Object.entries(p.questions).map(([key, q]) => [
						key,
						(q as { type: string }).type === "choice"
							? {
									type: "choice",
									choice: "insufficient_evidence",
									confidence: 1,
									probabilities: Object.fromEntries(
										Object.keys((q as { criteria: object }).criteria).map(
											(k) => [k, k === "insufficient_evidence" ? 1 : 0],
										),
									),
								}
							: { type: "noul", noul: 0.9 },
					]),
				),
			});
		});
		await ready;
		const duplicate = await processJob(db, "test", jobs[0].token, async () => {
			throw new Error("Duplicate provider call");
		});
		release();
		await direct;
		assert.ok("ack" in duplicate || "retry" in duplicate);
		assert.equal(calls, 1);
		assert.equal(preparations, 1);
	} finally {
		release?.();
		db.options.debug = debug;
	}
});
