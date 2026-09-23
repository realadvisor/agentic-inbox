import postgres from "postgres";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { createApi } from "../server/api";
import { InboxStore } from "../server/store";
import { askJev, processOne, runQueue } from "../server/classification/queue";
import { setConversationTags } from "../server/tags";
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
	await db`UPDATE classifier_worker_slots SET token=NULL,lease_until=NULL,cooldown_until=NULL`;
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
test("concurrent invocations make at most two provider requests, each job once", async () => {
	await reset();
	for (let i = 0; i < 8; i++) await message();
	let active = 0,
		max = 0,
		calls = 0;
	const slow: typeof fetch = async (...args) => {
		active++;
		calls++;
		max = Math.max(max, active);
		await new Promise((r) => setTimeout(r, 25));
		active--;
		return yes(...args);
	};
	await Promise.all(
		Array.from({ length: 8 }, () => runQueue(db, "test", 8, slow)),
	);
	await runQueue(db, "test", 8, slow);
	assert.equal(max, 2);
	assert.equal(calls, 8);
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
test("transient errors back off then become visible errors after three attempts", async () => {
	await reset();
	const thread = await message();
	const unavailable: typeof fetch = async () =>
		new Response("", { status: 503 });
	await run();
	for (let i = 0; i < 3; i++) {
		await processOne(db, "test", false, unavailable);
		if (i < 2) {
			assert.equal((await job(thread)).status, "pending");
			assert.ok(
				new Date((await job(thread)).available_at).getTime() > Date.now(),
			);
			await db`UPDATE conversation_classifications SET available_at=now()`;
		}
	}
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
			await db`SELECT * FROM classifier_worker_slots WHERE cooldown_until>now()+interval '100 seconds'`
		).length,
		2,
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
