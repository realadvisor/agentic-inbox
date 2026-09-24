import { readFile } from "node:fs/promises";
import {
	publishOutbox,
	parkBatch,
	consumeBatch,
	queueNames,
} from "../server/classification/dispatch";
import postgres from "postgres";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { createApi } from "../server/api";
import { InboxStore } from "../server/store";
import {
	askJev,
	processJob,
	failDelivery,
	finishRuns,
} from "../server/classification/queue";
import { setConversationTags } from "../server/tags";
// Test harness delivers individual broker jobs; production never polls for work.
async function processOne(
	target: typeof db,
	key: string,
	bulkFirst: boolean,
	request: typeof fetch,
) {
	const [j] =
		await target`SELECT token FROM conversation_classifications WHERE status='pending' AND available_at<=now() AND (lease_until IS NULL OR lease_until<now()) AND NOT EXISTS(SELECT 1 FROM classifier_provider_state WHERE cooldown_until>now()) ORDER BY ${bulkFirst ? target`priority DESC` : target`priority ASC`} LIMIT 1`;
	if (!j) return false;
	await processJob(target, key, j.token, request);
	return true;
}
async function runQueue(
	target: typeof db,
	key: string,
	rounds: number,
	request: typeof fetch,
) {
	for (let i = 0; i < rounds * 2; i++)
		if (!(await processOne(target, key, false, request))) break;
	await finishRuns(target);
}

const schema = "test_classifiers_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db);
const mailbox = "privacy@example.test";
const app = createApi(db, {
	readAttachment: async () => null,
	classifiersEnabled: true,
});
let classifierId: string, tagId: string;
const yes: typeof fetch = async () =>
	Response.json({
		model: "jev-test",
		answers: { match: { type: "noul", noul: 0.99 } },
	});
const uncertain: typeof fetch = async () =>
	Response.json({
		model: "jev-test",
		answers: { match: { type: "noul", noul: 0.5 } },
	});
async function call(path: string, method = "GET", body?: unknown) {
	return app.request("http://127.0.0.1:4311/api/v1/classification" + path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
async function reset() {
	await db`DELETE FROM classifier_run_items`;
	await db`DELETE FROM conversation_classifications`;
	await db`DELETE FROM classifier_runs`;
	await db`UPDATE classifiers SET enabled=false`;
	await db`DELETE FROM emails`;
	await db`DELETE FROM conversations`;
	await db`UPDATE classifier_provider_state SET cooldown_until=NULL`;
	await db`UPDATE classifiers SET enabled=true,mailbox_ids='{}' WHERE id=${classifierId}`;
}
async function message(
	thread = crypto.randomUUID(),
	body = "Please delete my personal data.",
	status = "received",
) {
	const id = crypto.randomUUID();
	await store.insert(mailbox, {
		id,
		thread_id: thread,
		sender: "customer@example.test",
		recipient: mailbox,
		subject: "Account",
		body,
		message_id: `<${id}@example.test>`,
		date: new Date(),
	});
	if (status !== "received")
		await db`UPDATE emails SET delivery_status=${status} WHERE id=${id}`;
	return thread;
}
async function job(thread: string) {
	return (
		await db`SELECT * FROM conversation_classifications WHERE thread_id=${thread} AND classifier_id=${classifierId}`
	)[0];
}
async function run(selection = "all", reset = false) {
	const r = await call(`/classifiers/${classifierId}/runs`, "POST", {
		mailbox_ids: [mailbox],
		selection,
		reset,
		enable: true,
	});
	assert.equal(r.status, 201, await r.clone().text());
	return r.json();
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Privacy");
	const [c] =
		await db`SELECT * FROM classifiers WHERE question LIKE '%delete%'`;
	classifierId = c.id;
	tagId = c.tag_id;
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("Jev noul contract, uncertainty and invalid answers", async () => {
	assert.equal((await askJev("test", "Question", {}, yes)).answer, true);
	assert.equal((await askJev("test", "Question", {}, uncertain)).answer, null);
	await assert.rejects(
		askJev("test", "Question", {}, async () =>
			Response.json({ answers: { match: { type: "noul", noul: 2 } } }),
		),
		/invalid_provider_answer/,
	);
});
test("presets start disabled and historical mail is not silently queued", async () => {
	assert.equal((await db`SELECT * FROM classifiers WHERE enabled`).length, 0);
	await message();
	assert.equal(
		(await db`SELECT * FROM conversation_classifications`).length,
		0,
	);
});
test("incoming mail queues, saves result and tag atomically, without a browser", async () => {
	await reset();
	const thread = await message();
	assert.equal((await job(thread)).status, "pending");
	let calls = 0;
	await runQueue(db, "test", 3, async (...args) => {
		calls++;
		const payload = JSON.parse(String(args[1]?.body));
		assert.equal(payload.questions.match.type, "noul");
		assert.equal(payload.state.messages[0].direction, "inbound");
		return yes(...args);
	});
	assert.equal(calls, 1);
	assert.equal((await job(thread)).answer, true);
	assert.equal(
		(
			await db`SELECT * FROM conversation_tags WHERE thread_id=${thread} AND removed_at IS NULL`
		).length,
		1,
	);
	await runQueue(db, "test", 3, yes);
	assert.equal((await job(thread)).attempts, 1);
});
test("duplicate deliveries execute the provider once and acknowledge completed work", async () => {
	await reset();
	const thread = await message();
	const row = await job(thread);
	let calls = 0;
	const slow: typeof fetch = async (...args) => {
		calls++;
		await new Promise((r) => setTimeout(r, 40));
		return yes(...args);
	};
	const results = await Promise.all(
		Array.from({ length: 8 }, () => processJob(db, "test", row.token, slow)),
	);
	assert.equal(calls, 1);
	assert.ok(results.some((r) => "ack" in r));
	assert.deepEqual(await processJob(db, "test", row.token, slow), {
		ack: true,
	});
	assert.equal(calls, 1);
});

test("new mail invalidates an in-flight result and its automatic tag", async () => {
	await reset();
	const thread = await message();
	await processOne(db, "test", false, async (...args) => {
		await message(thread, "Actually I need a copy too");
		return yes(...args);
	});
	assert.equal((await job(thread)).status, "pending");
	assert.equal(
		(await db`SELECT * FROM conversation_tags WHERE thread_id=${thread}`)
			.length,
		0,
	);
	await processOne(db, "test", false, yes);
	assert.equal((await job(thread)).status, "complete");
});
test("manual tag removals survive processing and explicit reset", async () => {
	await reset();
	const thread = await message();
	await processOne(db, "test", false, async (...args) => {
		await setConversationTags(
			db,
			mailbox,
			[thread],
			tagId,
			"remove",
			"reviewer",
		);
		return yes(...args);
	});
	await run("all", true);
	await runQueue(db, "test", 3, yes);
	const [tag] =
		await db`SELECT * FROM conversation_tags WHERE thread_id=${thread} AND tag_id=${tagId}`;
	assert.equal(tag.source, "manual");
	assert.ok(tag.removed_at);
	assert.equal((await job(thread)).status, "skipped");
});
test("human corrections are protected; stale corrections cannot overwrite new mail", async () => {
	await reset();
	const thread = await message();
	await processOne(db, "test", false, uncertain);
	let row = await job(thread);
	const path = `/results/${mailbox}/${thread}/${classifierId}`;
	assert.equal(
		(
			await call(path, "PUT", {
				answer: false,
				revision: row.revision,
				token: row.token,
			})
		).status,
		204,
	);
	await run();
	await runQueue(db, "test", 3, yes);
	assert.equal((await job(thread)).source, "human");
	row = await job(thread);
	await message(thread);
	assert.equal(
		(
			await call(path, "PUT", {
				answer: false,
				revision: row.revision,
				token: row.token,
			})
		).status,
		409,
	);
	await processOne(db, "test", false, yes);
	assert.equal((await job(thread)).source, "jev");
});
test("transient errors request broker retry and dead letters become visible errors", async () => {
	await reset();
	const thread = await message();
	const unavailable: typeof fetch = async () =>
		new Response("", { status: 503 });
	await run();
	for (let i = 0; i < 4; i++) {
		await processOne(db, "test", false, unavailable);
		if (i < 3) {
			assert.equal((await job(thread)).status, "pending");
			assert.ok(
				new Date((await job(thread)).available_at).getTime() > Date.now(),
			);
			await db`UPDATE conversation_classifications SET available_at=now()`;
		}
	}
	await failDelivery(db, (await job(thread)).token);
	assert.equal((await job(thread)).status, "error");
	assert.equal((await job(thread)).answer, null);
	const rows = await (await call("/classifiers")).json();
	assert.equal(
		rows.find((x: { id: string }) => x.id === classifierId).run.failed,
		1,
	);
	await run("unprocessed");
	await runQueue(db, "test", 3, yes);
	assert.equal((await job(thread)).status, "complete");
});
test("429 sets a shared provider cooldown", async () => {
	await reset();
	await message();
	await processOne(
		db,
		"test",
		false,
		async () =>
			new Response("", { status: 429, headers: { "Retry-After": "120" } }),
	);
	assert.equal(
		(
			await db`SELECT * FROM classifier_provider_state WHERE cooldown_until>now()+interval '100 seconds'`
		).length,
		1,
	);
	assert.equal(await processOne(db, "test", false, yes), false);
});
test("cancel fences in-flight bulk work; new arrivals are independent", async () => {
	await reset();
	const thread = await message();
	await run();
	await processOne(db, "test", true, async (...args) => {
		await call(`/classifiers/${classifierId}/cancel`, "POST", {});
		return yes(...args);
	});
	assert.equal((await job(thread)).status, "skipped");
	assert.equal(
		(await db`SELECT * FROM conversation_tags WHERE thread_id=${thread}`)
			.length,
		0,
	);
	await message(thread);
	await processOne(db, "test", false, yes);
	assert.equal((await job(thread)).status, "complete");
});
test("config changes fence results and do not automatically scan history", async () => {
	await reset();
	const thread = await message();
	await processOne(db, "test", false, async (...args) => {
		const [c] = await db`SELECT * FROM classifiers WHERE id=${classifierId}`;
		assert.equal(
			(
				await call(`/classifiers/${classifierId}`, "PUT", {
					question: c.question + " Please assess carefully.",
					tag_id: tagId,
					mailbox_ids: [],
					enabled: true,
					revision: c.revision,
				})
			).status,
			200,
		);
		return yes(...args);
	});
	assert.equal(await job(thread), undefined);
	assert.equal(
		(await db`SELECT * FROM conversation_tags WHERE thread_id=${thread}`)
			.length,
		0,
	);
});
test("spam is skipped, oversized conversations need review without provider calls; read updates do not requeue", async () => {
	await reset();
	const thread = await message(undefined, "x".repeat(100001));
	let calls = 0;
	await runQueue(db, "test", 3, async (...args) => {
		calls++;
		return yes(...args);
	});
	assert.equal(calls, 0);
	assert.equal((await job(thread)).status, "review");
	await db`UPDATE emails SET read=true WHERE thread_id=${thread}`;
	assert.equal((await job(thread)).status, "review");
	await db`UPDATE emails SET folder_id='spam' WHERE thread_id=${thread}`;
	await runQueue(db, "test", 3, yes);
	assert.equal((await job(thread)).status, "skipped");
});
test("expired leases recover after process interruption", async () => {
	await reset();
	const thread = await message();
	await db`UPDATE conversation_classifications SET lease_until=now()-interval '1 minute',attempts=1 WHERE thread_id=${thread}`;
	await runQueue(db, "test", 3, yes);
	assert.equal((await job(thread)).status, "complete");
	assert.equal((await job(thread)).attempts, 2);
});
test("live configuration changes require admin role", async () => {
	const restricted = createApi(db, {
		readAttachment: async () => null,
		mode: "live",
		origin: "https://inbox.realadvisor.com",
		actor: "joan@realadvisor.com",
		mailboxAdmins: ["jonas@realadvisor.com"],
		classifiersEnabled: true,
	});
	const response = await restricted.request(
		"https://inbox.realadvisor.com/api/v1/classification/classifiers/" +
			classifierId +
			"/runs",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		},
	);
	assert.equal(response.status, 403);
});

test("only confirmed sent replies requeue, and active folder moves preserve corrections", async () => {
	await reset();
	const thread = await message();
	await processOne(db, "test", false, uncertain);
	const row = await job(thread);
	await call(`/results/${mailbox}/${thread}/${classifierId}`, "PUT", {
		answer: false,
		revision: row.revision,
		token: row.token,
	});
	await db`INSERT INTO folders(mailbox_id,id,name) VALUES(${mailbox},'test-active','Test active') ON CONFLICT DO NOTHING`;
	await db`UPDATE emails SET folder_id='test-active' WHERE thread_id=${thread}`;
	assert.equal((await job(thread)).source, "human");
	const draftId = crypto.randomUUID();
	await db`INSERT INTO emails(id,mailbox_id,folder_id,sender,recipient,thread_id,message_id,delivery_status) VALUES(${draftId},${mailbox},'draft',${mailbox},'customer@example.test',${thread},${draftId},'draft')`;
	assert.equal((await job(thread)).source, "human");
	await db`UPDATE emails SET delivery_status='sending' WHERE id=${draftId}`;
	assert.equal((await job(thread)).source, "human");
	await db`UPDATE emails SET delivery_status='sent',folder_id='sent' WHERE id=${draftId}`;
	assert.equal((await job(thread)).status, "pending");
	let sent = false;
	await processOne(db, "test", false, async (...args) => {
		const payload = JSON.parse(String(args[1]?.body));
		sent = payload.state.messages.some(
			(m: { direction: string }) => m.direction === "outbound",
		);
		return yes(...args);
	});
	assert.equal(sent, true);
});

test("Cloudflare connections without type discovery round-trip mailbox scopes", async () => {
	const workerDb = postgres(process.env.DATABASE_URL!, {
		fetch_types: false,
		connection: { search_path: schema },
	});
	try {
		const workerApi = createApi(workerDb, {
			readAttachment: async () => null,
			classifiersEnabled: true,
		});
		const request = async (path: string, method = "GET", body?: unknown) => {
			return workerApi.request(
				"http://127.0.0.1:4311/api/v1/classification" + path,
				{
					method,
					headers: { "Content-Type": "application/json" },
					body: body === undefined ? undefined : JSON.stringify(body),
				},
			);
		};
		const [tag] =
			await db`INSERT INTO tags(name,color) VALUES('Scope regression','#123456') RETURNING id`;
		const input = {
			question: "Does this need attention?",
			tag_id: tag.id,
			mailbox_ids: [mailbox],
			enabled: false,
		};
		const created = await request("/classifiers", "POST", input);
		assert.equal(created.status, 201, await created.clone().text());
		const c = await created.json();
		assert.deepEqual(c.mailbox_ids, [mailbox]);
		const listed = await (await request("/classifiers")).json();
		assert.ok(
			listed.every((x: { mailbox_ids: unknown }) =>
				Array.isArray(x.mailbox_ids),
			),
		);
		const updated = await request("/classifiers/" + c.id, "PUT", {
			...input,
			revision: c.revision,
			enabled: true,
		});
		assert.equal(updated.status, 200, await updated.clone().text());
		assert.deepEqual((await updated.json()).mailbox_ids, [mailbox]);
		const run = await request("/classifiers/" + c.id + "/runs", "POST", {
			mailbox_ids: [mailbox],
			selection: "all",
		});
		assert.equal(run.status, 201, await run.clone().text());
		await runQueue(workerDb, "test", 3, yes);
		assert.equal(
			(
				await db`SELECT status FROM classifier_runs WHERE classifier_id=${c.id}`
			)[0].status,
			"completed",
		);
	} finally {
		await workerDb.end();
	}
});

test("outbox intent is atomic with job changes and ambiguous publishes are safe", async () => {
	await reset();
	const thread = await message();
	const row = await job(thread);
	await assert.rejects(
		db.begin(async (tx) => {
			await tx`UPDATE conversation_classifications SET token=gen_random_uuid() WHERE token=${row.token}`;
			throw new Error("rollback");
		}),
		/rollback/,
	);
	assert.equal(
		(await db`SELECT job_token FROM classifier_outbox`)[0].job_token,
		row.token,
	);
	const sent: unknown[] = [];
	const broken = {
		sendBatch: async (messages: unknown[]) => {
			sent.push(...messages);
			throw new Error("ambiguous broker response");
		},
	};
	await assert.rejects(
		publishOutbox(db, { live: broken, backfill: broken }),
		/ambiguous/,
	);
	assert.equal(
		(await db`SELECT published_at FROM classifier_outbox`)[0].published_at,
		null,
	);
	const queue = {
		sendBatch: async (messages: unknown[]) => {
			sent.push(...messages);
		},
	};
	assert.equal(await publishOutbox(db, { live: queue, backfill: queue }), 1);
	assert.deepEqual(sent[0], sent[1]);
	assert.deepEqual(Object.keys((sent[0] as { body: object }).body).sort(), [
		"token",
		"version",
	]);
	assert.equal(await publishOutbox(db, { live: queue, backfill: queue }), 0);
});

test("concurrent outbox publishers split batches and isolate live mail from backfills", async () => {
	await reset();
	const liveThread = await message();
	const bulkThread = await message();
	await db`UPDATE conversation_classifications SET priority=1 WHERE thread_id=${bulkThread}`;
	const live: unknown[] = [],
		bulk: unknown[] = [];
	const queues = {
		live: {
			sendBatch: async (m: unknown[]) => {
				live.push(...m);
			},
		},
		backfill: {
			sendBatch: async (m: unknown[]) => {
				bulk.push(...m);
			},
		},
	};
	const counts = await Promise.all([
		publishOutbox(db, queues),
		publishOutbox(db, queues),
	]);
	assert.equal(
		counts.reduce((a, b) => a + b, 0),
		2,
	);
	assert.equal(live.length, 1);
	assert.equal(bulk.length, 1);
	assert.equal(
		(live[0] as { body: { token: string } }).body.token,
		(await job(liveThread)).token,
	);
});

test("broker messages acknowledge success and duplicates, retry transient failure, and dead-letter terminal failure", async () => {
	await reset();
	const thread = await message();
	const row = await job(thread);
	let acks = 0;
	const retries: number[] = [];
	const m = {
		body: { version: 1, token: row.token },
		ack: () => {
			acks++;
		},
		retry: (o: { delaySeconds: number }) => {
			retries.push(o.delaySeconds);
		},
	};
	await run();
	const current = await job(thread);
	m.body.token = current.token;
	await consumeBatch(
		db,
		"test",
		{ queue: queueNames.live, messages: [m] },
		async () => new Response("", { status: 503 }),
	);
	assert.equal(acks, 0);
	assert.ok(retries[0] >= 30);
	assert.equal((await job(thread)).status, "pending");
	await consumeBatch(
		db,
		"test",
		{ queue: queueNames.dead, messages: [m] },
		yes,
	);
	assert.equal(acks, 1);
	assert.equal((await job(thread)).status, "error");
	assert.equal(
		(await db`SELECT status FROM classifier_runs`)[0].status,
		"completed",
	);
	await run("unprocessed");
	m.body.token = (await job(thread)).token;
	await consumeBatch(
		db,
		"test",
		{ queue: queueNames.backfill, messages: [m] },
		yes,
	);
	await consumeBatch(
		db,
		"test",
		{ queue: queueNames.backfill, messages: [m] },
		async () => {
			throw new Error("duplicate must not call provider");
		},
	);
	assert.equal(acks, 3);
	assert.equal((await job(thread)).status, "complete");
	assert.equal((await db`SELECT * FROM classifier_outbox`).length, 0);
});

test("stale queued and dead-letter deliveries cannot overwrite new mail or cancellation", async () => {
	await reset();
	const thread = await message();
	await run();
	const old = await job(thread);
	const m = {
		body: { version: 1, token: old.token },
		ack: () => {},
		retry: () => {
			throw new Error("stale job should be acknowledged");
		},
	};
	await message(thread);
	const next = await job(thread);
	assert.notEqual(next.token, old.token);
	await consumeBatch(
		db,
		"test",
		{ queue: queueNames.dead, messages: [m] },
		yes,
	);
	await consumeBatch(
		db,
		"test",
		{ queue: queueNames.live, messages: [m] },
		async () => {
			throw new Error("stale");
		},
	);
	assert.equal((await job(thread)).status, "pending");
	assert.equal((await job(thread)).token, next.token);
	await call(`/classifiers/${classifierId}/cancel`, "POST", {});
	assert.equal((await job(thread)).status, "pending"); // Independent new mail survives cancelled backfill.
	assert.equal(
		(await db`SELECT count(*)::int AS count FROM classifier_outbox`)[0].count,
		1,
	);
});

test("retention-expired queue delivery is recoverable from the outbox", async () => {
	await reset();
	await message();
	let calls = 0;
	const queues = {
		live: {
			sendBatch: async () => {
				calls++;
			},
		},
		backfill: {
			sendBatch: async () => {
				calls++;
			},
		},
	};
	await publishOutbox(db, queues);
	await db`UPDATE classifier_outbox SET published_at=now()-interval '26 hours'`;
	await publishOutbox(db, queues);
	assert.equal(calls, 2);
});

test("queue config bounds provider concurrency and routes exhausted deliveries to a DLQ", async () => {
	const text = await readFile(
		new URL("../wrangler.jsonc", import.meta.url),
		"utf8",
	);
	const config = JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
	const consumers = config.queues.consumers.filter(
		(c: { queue: string }) =>
			c.queue === queueNames.live || c.queue === queueNames.backfill,
	);
	assert.equal(consumers.length, 2);
	assert.equal(
		consumers.find((c: { queue: string }) => c.queue === queueNames.live)
			.max_concurrency,
		1,
	);
	assert.equal(
		consumers.find((c: { queue: string }) => c.queue === queueNames.backfill)
			.max_concurrency,
		5,
	);
	for (const c of consumers) {
		assert.equal(c.max_batch_size, 1);
		assert.equal(c.dead_letter_queue, queueNames.dead);
		assert.equal(c.max_retries, 3);
	}
	assert.deepEqual(config.triggers.crons, ["*/15 * * * *"]);
});

test("pausing preserves dispatch intent without exhausting broker retries", async () => {
	await reset();
	const thread = await message();
	const row = await job(thread);
	const queues = {
		live: { sendBatch: async () => {} },
		backfill: { sendBatch: async () => {} },
	};
	await publishOutbox(db, queues);
	let acknowledged = false;
	await parkBatch(db, {
		queue: queueNames.live,
		messages: [
			{
				body: { version: 1, token: row.token },
				ack: () => {
					acknowledged = true;
				},
				retry: () => {
					throw new Error("must not retry while paused");
				},
			},
		],
	});
	assert.equal(acknowledged, true);
	assert.equal(
		(await db`SELECT published_at FROM classifier_outbox`)[0].published_at,
		null,
	);
	assert.equal(await publishOutbox(db, queues), 1);
	assert.equal((await job(thread)).attempts, 0);
});

test("dead-letter duplicates cannot interrupt an active provider request", async () => {
	await reset();
	const thread = await message();
	const row = await job(thread);
	await processJob(db, "test", row.token, async (...args) => {
		const result = await failDelivery(db, row.token);
		assert.ok("retry" in result);
		return yes(...args);
	});
	assert.equal((await job(thread)).status, "complete");
});

test("human example snapshots preserve decision-time evidence and exclude predictions", async () => {
	await reset();
	const thread = await message(undefined, "Please answer this question.");
	await processJob(db, "test", (await job(thread)).token, yes);
	assert.equal((await db`SELECT * FROM classifier_examples`).length, 0);
	await setConversationTags(
		db,
		mailbox,
		[thread],
		tagId,
		"add",
		"reviewer@example.test",
	);
	const [positive] = await db`SELECT * FROM classifier_examples`;
	assert.equal(positive.answer, true);
	assert.equal(positive.source, "manual");
	assert.equal(positive.messages.length, 1);
	await message(thread, "A later response", "sent");
	assert.deepEqual(
		(await db`SELECT messages FROM classifier_examples`)[0].messages,
		positive.messages,
	);
	await setConversationTags(
		db,
		mailbox,
		[thread],
		tagId,
		"remove",
		"reviewer@example.test",
	);
	const [negative] = await db`SELECT * FROM classifier_examples`;
	assert.equal(negative.answer, false);
	assert.equal(negative.messages.length, 2);
	await message(thread, "x".repeat(13000));
	await setConversationTags(
		db,
		mailbox,
		[thread],
		tagId,
		"add",
		"reviewer@example.test",
	);
	assert.equal(
		(await db`SELECT * FROM classifier_examples`).length,
		0,
		"oversized relabel removes stale example",
	);
});

test("human classifier review becomes a labeled example without draft evidence", async () => {
	await reset();
	const thread = await message();
	await message(thread, "Unsent draft", "draft");
	await processJob(db, "test", (await job(thread)).token, uncertain);
	const row = await job(thread);
	const response = await call(
		`/results/${mailbox}/${thread}/${classifierId}`,
		"PUT",
		{
			answer: false,
			revision: row.revision,
			token: row.token,
		},
	);
	assert.equal(response.status, 204, await response.text());
	const [example] = await db`SELECT * FROM classifier_examples`;
	assert.equal(example.answer, false);
	assert.equal(example.source, "review");
	assert.equal(example.messages.length, 1);
});

test("examples are opt-in, balanced, bounded, mailbox-scoped and separate from target", async () => {
	await reset();
	await db`UPDATE classifiers SET include_reviewed_examples=false WHERE id=${classifierId}`;
	for (let i = 0; i < 8; i++) {
		const thread = await message(undefined, `Human example ${i}`);
		await setConversationTags(
			db,
			mailbox,
			[thread],
			tagId,
			i < 4 ? "add" : "remove",
			"reviewer@example.test",
		);
	}
	const target = await message(undefined, "Current conversation");
	let body: {
		questions: {
			match: {
				criteria?: {
					true: { examples: unknown[] };
					false: { examples: unknown[] };
				};
			};
		};
		state: { messages: unknown[] };
	} = { questions: { match: {} }, state: { messages: [] } };
	const capture: typeof fetch = async (_url, init) => {
		body = JSON.parse(init!.body as string);
		return yes(_url, init);
	};
	await processJob(db, "test", (await job(target)).token, capture);
	assert.equal(Object.hasOwn(body.questions.match, "criteria"), false);
	await db`UPDATE classifiers SET include_reviewed_examples=true WHERE id=${classifierId}`;
	await message(target, "New current message");
	await processJob(db, "test", (await job(target)).token, capture);
	assert.ok(body.questions.match.criteria);
	assert.equal(body.questions.match.criteria.true.examples.length, 3);
	assert.equal(body.questions.match.criteria.false.examples.length, 3);
	assert.equal(body.state.messages.length, 2);
	assert.ok(
		!JSON.stringify(body.questions.match.criteria).includes(
			"Current conversation",
		),
	);
	assert.ok(
		JSON.stringify(body.questions.match.criteria).includes("Human example 3"),
	);
	assert.ok(
		!JSON.stringify(body.questions.match.criteria).includes("Human example 0"),
	);
	const { recentExamples } = await import("../server/classification/examples");
	const [{ question }] =
		await db`SELECT question FROM classifiers WHERE id=${classifierId}`;
	assert.equal(
		(
			await recentExamples(
				db,
				classifierId,
				"other@example.test",
				target,
				question,
			)
		).length,
		0,
	);
	assert.equal(
		(
			await recentExamples(
				db,
				classifierId,
				mailbox,
				target,
				"Different question",
			)
		).length,
		0,
	);
	assert.equal(
		(await recentExamples(db, classifierId, mailbox, target, question, 1))
			.length,
		0,
	);
	const [own] = await db`SELECT thread_id FROM classifier_examples LIMIT 1`;
	assert.equal(
		(await recentExamples(db, classifierId, mailbox, own.thread_id, question))
			.length,
		6,
	);
	await db`UPDATE classifier_examples SET labeled_at=now()-interval '31 days'`;
	assert.equal(
		(await recentExamples(db, classifierId, mailbox, target, question)).length,
		0,
	);
});

test("example setting persists without clearing decisions; changing question clears examples", async () => {
	await reset();
	const thread = await message();
	await setConversationTags(
		db,
		mailbox,
		[thread],
		tagId,
		"add",
		"reviewer@example.test",
	);
	let [c] =
		await db`SELECT *,to_json(mailbox_ids) AS mailbox_ids FROM classifiers WHERE id=${classifierId}`;
	const update = (extra: Record<string, unknown>) =>
		call(`/classifiers/${classifierId}`, "PUT", {
			question: c.question,
			tag_id: c.tag_id,
			mailbox_ids: c.mailbox_ids,
			enabled: c.enabled,
			revision: c.revision,
			...extra,
		});
	let response = await update({ include_reviewed_examples: true });
	assert.equal(response.status, 200);
	c = await response.json();
	assert.equal(c.include_reviewed_examples, true);
	assert.equal((await db`SELECT * FROM classifier_examples`).length, 1);
	response = await update({});
	c = await response.json();
	assert.equal(c.include_reviewed_examples, true);
	response = await update({ question: "A new question?" });
	assert.equal(response.status, 200);
	assert.equal((await db`SELECT * FROM classifier_examples`).length, 0);
});

async function siblingClassifier(question: string) {
	const [tag] =
		await db`INSERT INTO tags(name,color) VALUES(${crypto.randomUUID()},'#2563eb') RETURNING id`;
	const [c] =
		await db`INSERT INTO classifiers(tag_id,question,enabled,include_reviewed_examples) VALUES(${tag.id},${question},true,true) RETURNING *`;
	return c;
}

test("one Jev call answers three classifiers with independent examples and probabilities", async () => {
	await reset();
	await db`UPDATE classifiers SET include_reviewed_examples=true WHERE id=${classifierId}`;
	const second = await siblingClassifier("Second question?"),
		third = await siblingClassifier("Third question?");
	const example = await message(undefined, "Historical human decision");
	await setConversationTags(db, mailbox, [example], tagId, "add", "human");
	await setConversationTags(
		db,
		mailbox,
		[example],
		second.tag_id,
		"remove",
		"human",
	);
	const target = await message(undefined, "Target for three classifiers");
	let calls = 0;
	const request: typeof fetch = async (_url, init) => {
		calls++;
		const body = JSON.parse(init!.body as string);
		assert.equal(Object.keys(body.questions).length, 3);
		assert.equal(body.state.messages.length, 1);
		const answers = Object.fromEntries(
			Object.entries(body.questions).map(([id, raw]) => {
				const q = raw as {
					instructions: string;
					criteria?: {
						true: { examples: unknown[] };
						false: { examples: unknown[] };
					};
				};
				const isSecond = q.instructions.includes("Second question?"),
					isThird = q.instructions.includes("Third question?");
				if (isSecond) {
					assert.equal(q.criteria?.false.examples.length, 1);
					assert.equal(q.criteria?.true.examples.length, 0);
				} else if (!isThird) assert.equal(q.criteria?.true.examples.length, 1);
				else assert.equal(q.criteria, undefined);
				return [
					id,
					{ type: "noul", noul: isSecond ? 0.01 : isThird ? 0.5 : 0.99 },
				];
			}),
		);
		return Response.json({ model: "jev-test", answers });
	};
	await processJob(db, "test", (await job(target)).token, request);
	assert.equal(calls, 1);
	const rows =
		await db`SELECT * FROM conversation_classifications WHERE thread_id=${target}`;
	assert.equal(
		rows.find((r) => r.classifier_id === classifierId)?.answer,
		true,
	);
	assert.equal(rows.find((r) => r.classifier_id === second.id)?.answer, false);
	assert.equal(
		rows.find((r) => r.classifier_id === third.id)?.status,
		"review",
	);
	for (const row of rows) await processJob(db, "test", row.token, request);
	assert.equal(
		calls,
		1,
		"later broker deliveries must not repeat completed questions",
	);
});

test("missing batch answers retry independently without discarding successful siblings", async () => {
	await reset();
	await siblingClassifier("Missing answer question?");
	const target = await message();
	await processJob(
		db,
		"test",
		(await job(target)).token,
		async (_url, init) => {
			const { questions } = JSON.parse(init!.body as string);
			const answers = Object.fromEntries(
				Object.entries(questions)
					.filter(
						([, q]) =>
							!(q as { instructions: string }).instructions.includes(
								"Missing answer question?",
							),
					)
					.map(([id]) => [id, { type: "noul", noul: 0.99 }]),
			);
			return Response.json({ answers });
		},
	);
	assert.equal((await job(target)).status, "complete");
	const [missing] =
		await db`SELECT * FROM conversation_classifications WHERE thread_id=${target} AND classifier_id<>${classifierId}`;
	assert.equal(missing.status, "pending");
	assert.equal(missing.error, "invalid_provider_answer");
	await db`UPDATE conversation_classifications SET available_at=now() WHERE token=${missing.token}`;
	await processJob(db, "test", missing.token, yes);
	assert.equal(
		(
			await db`SELECT status FROM conversation_classifications WHERE token=${missing.token}`
		)[0].status,
		"complete",
	);
});

test("human overrides and classifier edits during a batch fence only the affected results", async () => {
	await reset();
	const second = await siblingClassifier("Edited question?"),
		third = await siblingClassifier("Unchanged question?");
	const target = await message();
	await processJob(
		db,
		"test",
		(await job(target)).token,
		async (_url, init) => {
			const { questions } = JSON.parse(init!.body as string);
			await setConversationTags(
				db,
				mailbox,
				[target],
				tagId,
				"remove",
				"human",
			);
			await db`UPDATE classifiers SET revision=revision+1 WHERE id=${second.id}`;
			return Response.json({
				answers: Object.fromEntries(
					Object.keys(questions).map((id) => [
						id,
						{ type: "noul", noul: 0.99 },
					]),
				),
			});
		},
	);
	assert.equal((await job(target)).status, "skipped");
	const tags =
		await db`SELECT * FROM conversation_tags WHERE thread_id=${target}`;
	assert.ok(tags.find((t) => t.tag_id === tagId)?.removed_at);
	assert.equal(
		tags.find((t) => t.tag_id === second.tag_id),
		undefined,
	);
	assert.equal(tags.find((t) => t.tag_id === third.tag_id)?.removed_at, null);
});

test("new mail during a batched request prevents every stale answer from being applied", async () => {
	await reset();
	await siblingClassifier("Another question?");
	const target = await message();
	await processJob(
		db,
		"test",
		(await job(target)).token,
		async (_url, init) => {
			const { questions } = JSON.parse(init!.body as string);
			await message(target, "New evidence while Jev was answering");
			return Response.json({
				answers: Object.fromEntries(
					Object.keys(questions).map((id) => [
						id,
						{ type: "noul", noul: 0.99 },
					]),
				),
			});
		},
	);
	assert.equal(
		(await db`SELECT * FROM conversation_tags WHERE thread_id=${target}`)
			.length,
		0,
	);
	const jobs =
		await db`SELECT status,answer FROM conversation_classifications WHERE thread_id=${target}`;
	assert.equal(jobs.length, 2);
	for (const j of jobs) {
		assert.equal(j.status, "pending");
		assert.equal(j.answer, null);
	}
});

test("overlapping deliveries never send the same question twice", async () => {
	await reset();
	await siblingClassifier("Concurrent sibling?");
	const target = await message();
	const jobs =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${target}`;
	const asked: string[] = [];
	const request: typeof fetch = async (_url, init) => {
		const { questions } = JSON.parse(init!.body as string);
		for (const q of Object.values(questions))
			asked.push((q as { instructions: string }).instructions);
		await new Promise((resolve) => setTimeout(resolve, 20));
		return Response.json({
			answers: Object.fromEntries(
				Object.keys(questions).map((id) => [id, { type: "noul", noul: 0.99 }]),
			),
		});
	};
	await Promise.all(jobs.map((j) => processJob(db, "test", j.token, request)));
	assert.equal(asked.length, 2);
	assert.equal(new Set(asked).size, 2);
	assert.equal(
		(
			await db`SELECT * FROM conversation_classifications WHERE thread_id=${target} AND status='complete'`
		).length,
		2,
	);
});

test("all ready classifiers are included without the former three-question cap", async () => {
	await reset();
	for (let i = 0; i < 7; i++) await siblingClassifier(`Extra question ${i}?`);
	const target = await message();
	let calls = 0;
	await processJob(
		db,
		"test",
		(await job(target)).token,
		async (_url, init) => {
			calls++;
			const { questions } = JSON.parse(init!.body as string);
			assert.equal(Object.keys(questions).length, 8);
			return Response.json({
				answers: Object.fromEntries(
					Object.keys(questions).map((id) => [
						id,
						{ type: "noul", noul: 0.99 },
					]),
				),
			});
		},
	);
	assert.equal(calls, 1);
	assert.equal(
		(
			await db`SELECT * FROM conversation_classifications WHERE thread_id=${target} AND status='complete'`
		).length,
		8,
	);
});

test("needs-review filter counts and paginates unresolved conversations across folders", async () => {
	await reset();
	const reviewThread = await message();
	await message(reviewThread);
	const errorThread = await message();
	const pendingThread = await message();
	const completedThread = await message();
	const staleThread = await message();
	const manualThread = await message();
	await db`UPDATE emails SET folder_id='archive' WHERE thread_id=${errorThread}`;
	for (const thread of [reviewThread, errorThread, staleThread, manualThread]) {
		await db`UPDATE conversation_classifications SET status='review',answer=NULL WHERE thread_id=${thread}`;
	}
	await db`UPDATE conversation_classifications SET status='error' WHERE thread_id=${errorThread}`;
	await db`UPDATE conversation_classifications SET status='complete',answer=true WHERE thread_id=${completedThread}`;
	await db`UPDATE conversation_classifications SET revision=0 WHERE thread_id=${staleThread}`;
	await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at)
		VALUES(${mailbox},${manualThread},${tagId},'manual','review-test',now())`;
	const path = `/api/v1/mailboxes/${mailbox}/emails?needs_review=true&threaded=true&limit=1`;
	const firstResponse = await app.request(`http://127.0.0.1:4311${path}`);
	assert.equal(firstResponse.status, 200);
	const first = await firstResponse.json();
	const second = await (
		await app.request(`http://127.0.0.1:4311${path}&page=2`)
	).json();
	assert.equal(first.totalCount, 2);
	assert.equal(first.emails.length, 1);
	assert.equal(second.totalCount, 2);
	assert.deepEqual(
		new Set([first.emails[0].thread_id, second.emails[0].thread_id]),
		new Set([reviewThread, errorThread]),
	);
	const inbox = await store.list(mailbox, {
		needs_review: "true",
		threaded: "true",
		folder: "inbox",
	});
	assert.equal(inbox.totalCount, 1);
	assert.equal(inbox.emails[0].thread_id, reviewThread);
	assert.equal((await job(pendingThread)).status, "pending");
	await db`UPDATE conversation_classifications SET status='complete',answer=false WHERE thread_id=${reviewThread}`;
	assert.equal(
		(await store.list(mailbox, { needs_review: "true", threaded: "true" }))
			.totalCount,
		1,
	);
	await db`UPDATE classifiers SET enabled=false WHERE id=${classifierId}`;
	assert.equal(
		(await store.list(mailbox, { needs_review: "true", threaded: "true" }))
			.totalCount,
		0,
	);
	assert.equal(
		(
			await app.request(
				`http://127.0.0.1:4311${path.replace("needs_review=true", "needs_review=invalid")}`,
			)
		).status,
		400,
	);
});
