import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { createApi } from "../server/api";
import { InboxStore } from "../server/store";
import { advanceBackfills } from "../server/classification/backfills";
import { processJob } from "../server/classification/queue";
const schema = "test_backfills_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db);
const mailbox = "backfill@example.test";
const app = createApi(db, {
	readAttachment: async () => null,
	classifiersEnabled: true,
});
let classifier: string;
const yes: typeof fetch = async () =>
	Response.json({
		model: "jev-test",
		answers: { match: { type: "noul", noul: 0.99 } },
	});
async function call(path: string, method = "GET", body?: unknown) {
	return app.request("http://127.0.0.1:4311/api/v1/classification" + path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}
async function start(selection = "unprocessed") {
	const response = await call("/backfills", "POST", {
		classifier_ids: [classifier],
		mailbox_ids: [mailbox],
		selection,
	});
	assert.equal(response.status, 202, await response.clone().text());
	return (await response.json())[0];
}
async function reset() {
	await db`DELETE FROM conversation_classifications`;
	await db`DELETE FROM classifier_runs`;
	await db`DELETE FROM emails`;
	await db`DELETE FROM conversations`;
	await db`DELETE FROM classifier_result_cache`;
	await db`UPDATE classifiers SET enabled=false`;
}
async function email(body = "Identical evidence", recipient = mailbox) {
	const row = await store.insert(mailbox, {
		sender: "person@example.test",
		recipient,
		subject: "Privacy",
		body,
		date: new Date("2026-09-01T10:00:00Z"),
		folder_id: "archive",
	});
	assert.ok(row);
	return row.thread_id!;
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Backfill");
	const [tag] =
		await db`INSERT INTO tags(name,color) VALUES('Backfill test','#123456') RETURNING id`;
	const [row] =
		await db`INSERT INTO classifiers(tag_id,question) VALUES(${tag.id},'Does this need action?') RETURNING id`;
	classifier = row.id;
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("25,001 archived conversations start asynchronously and enter a bounded queue", async () => {
	await reset();
	await db.begin(async (tx) => {
		await tx`SELECT set_config('inbox.historical_import','on',true)`;
		await tx`INSERT INTO emails(id,mailbox_id,folder_id,subject,sender,recipient,date,body,thread_id,message_id,delivery_status) SELECT gen_random_uuid(),${mailbox},'archive','Synthetic historical email','sender@example.test',${mailbox},'2026-09-01'::timestamptz,'Synthetic body',gen_random_uuid(),n::text||'@backfill.test','received' FROM generate_series(1,25001) n`;
	});
	const preview = await call("/backfills/preview", "POST", {
		classifier_ids: [classifier],
		mailbox_ids: [mailbox],
	});
	assert.equal((await preview.json()).count, 25001);
	const run = await start();
	assert.equal(run.prepared, false);
	assert.equal(
		(await db`SELECT count(*)::int n FROM classifier_run_items`)[0].n,
		0,
	);
	await advanceBackfills(db);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM classifier_run_items WHERE run_id=${run.id}`
		)[0].n,
		25001,
	);
	for (let i = 0; i < 6; i++) await advanceBackfills(db);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM conversation_classifications WHERE status='pending'`
		)[0].n,
		500,
	);
	const [progress] = await (await call("/backfills")).json();
	assert.equal(progress.total, 25001);
	assert.equal(progress.pending, 25001);
	assert.equal(progress.waiting, 24501);
	await call("/classifiers/" + classifier + "/cancel", "POST", {});
	await advanceBackfills(db);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM classifier_run_items WHERE status='pending'`
		)[0].n,
		0,
	);
});

test("identical full inputs reuse a result; recipients and new conversation content do not", async () => {
	await reset();
	const first = await email(),
		second = await email();
	await email("Identical evidence", "different@example.test");
	await email("Different evidence");
	const run = await start();
	await advanceBackfills(db);
	let requests = 0;
	const provider: typeof fetch = async (...args) => {
		requests++;
		return yes(...args);
	};
	const jobs =
		await db`SELECT token FROM conversation_classifications ORDER BY thread_id`;
	for (const job of jobs) await processJob(db, "test", job.token, provider);
	assert.equal(requests, 3);
	const [progress] = await (await call("/backfills")).json();
	assert.equal(progress.status, "completed");
	assert.equal(progress.processed, 4);
	assert.equal(progress.reused, 1);
	assert.equal((await db`SELECT count(*)::int n FROM emails`)[0].n, 4);
	const again = await start();
	assert.notEqual(again.id, run.id);
	await advanceBackfills(db);
	const [unchanged] = await (await call("/backfills")).json();
	assert.equal(unchanged.unchanged, 4);
	assert.equal(unchanged.status, "completed");
	// A new reply changes the generation and input; old classifications cannot count as current.
	await store.insert(mailbox, {
		thread_id: first,
		sender: "person@example.test",
		recipient: mailbox,
		subject: "Follow-up",
		body: "New request",
		folder_id: "archive",
	});
	await start();
	await advanceBackfills(db);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM conversation_classifications WHERE status='pending'`
		)[0].n,
		1,
	);
	assert.ok(second);
});

test("a teaching example edit changes the evaluation key and makes completed work outdated", async () => {
	await reset();
	const thread = await email();
	await start();
	await advanceBackfills(db);
	const [job] = await db`SELECT * FROM conversation_classifications`;
	await processJob(db, "test", job.token, yes);
	const [beforeKey] =
		await db`SELECT classifier_config_key(${classifier},${mailbox}) AS key`;
	await db`INSERT INTO jev_examples(classifier_id,mailbox_id,thread_id,role,labels,state,config,actor) VALUES(${classifier},${mailbox},${thread},'teach','["yes"]','{}','test','test')`;
	const [afterKey] =
		await db`SELECT classifier_config_key(${classifier},${mailbox}) AS key`;
	assert.notEqual(beforeKey.key, afterKey.key);
	await start();
	await advanceBackfills(db);
	assert.equal(
		(await db`SELECT status FROM conversation_classifications`)[0].status,
		"pending",
	);
});

test("unchanged standalone settings preserve the version, result and job token", async () => {
	await reset();
	await email();
	await start();
	await advanceBackfills(db);
	const [job] = await db`SELECT * FROM conversation_classifications`;
	await processJob(db, "test", job.token, yes);
	const [c] =
		await db`SELECT *,to_json(mailbox_ids) AS mailbox_ids FROM classifiers WHERE id=${classifier}`;
	const response = await call("/classifiers/" + classifier, "PUT", {
		question: c.question,
		tag_id: c.tag_id,
		mailbox_ids: c.mailbox_ids,
		enabled: c.enabled,
		revision: c.revision,
	});
	assert.equal(response.status, 200, await response.clone().text());
	assert.equal((await response.json()).revision, c.revision);
	const [afterJob] =
		await db`SELECT token,status FROM conversation_classifications`;
	assert.equal(afterJob.token, job.token);
	assert.equal(afterJob.status, "complete");
});

test("deleted or superseded jobs do not leave a backfill stuck forever", async () => {
	await reset();
	await email();
	await start();
	await advanceBackfills(db);
	await db`DELETE FROM conversation_classifications`;
	await advanceBackfills(db);
	const [run] = await (await call("/backfills")).json();
	assert.equal(run.status, "completed");
	assert.equal(run.skipped, 1);
	assert.equal(run.pending, 0);
});

test("concurrent duplicate evaluations share one provider call and keep retry budget", async () => {
	await reset();
	await email();
	await email();
	await start();
	await advanceBackfills(db);
	const jobs =
		await db`SELECT token FROM conversation_classifications ORDER BY token`;
	let release!: () => void;
	let entered!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let calls = 0;
	const first = processJob(db, "test", jobs[0].token, async (...args) => {
		calls++;
		entered();
		await waiting;
		return yes(...args);
	});
	await started;
	const second = await processJob(db, "test", jobs[1].token, yes);
	assert.ok("retry" in second);
	assert.equal(
		(
			await db`SELECT attempts FROM conversation_classifications WHERE token=${jobs[1].token}`
		)[0].attempts,
		0,
	);
	release();
	await first;
	await db`UPDATE conversation_classifications SET available_at=now() WHERE token=${jobs[1].token}`;
	await processJob(db, "test", jobs[1].token, async () => {
		throw new Error("duplicate provider call");
	});
	assert.equal(calls, 1);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM conversation_classifications WHERE status='complete'`
		)[0].n,
		2,
	);
});

test("cosmetic group edits preserve evaluation versions and existing results", async () => {
	await reset();
	const input = {
		name: "Cosmetic test",
		selection: "multiple",
		instructions: "Find applicable labels",
		enabled: false,
		tags: [
			{
				id: crypto.randomUUID(),
				name: "Cosmetic label",
				description: "A test label",
				color: "#123456",
			},
		],
	};
	const response = await app.request(
		"http://127.0.0.1:4311/api/v1/tag-groups",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(input),
		},
	);
	assert.equal(response.status, 201, await response.clone().text());
	const group = await response.json();
	const [original] =
		await db`SELECT * FROM classifiers WHERE tag_id=${input.tags[0].id}`;
	const thread = await email();
	await db`INSERT INTO conversation_classifications(mailbox_id,thread_id,classifier_id,revision,generation,status) SELECT ${mailbox},${thread},${original.id},${original.revision},generation,'complete' FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${thread}`;
	const save = await app.request(
		"http://127.0.0.1:4311/api/v1/tag-groups/" + group.id,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...input,
				revision: group.revision,
				tags: [{ ...input.tags[0], color: "#abcdef" }],
			}),
		},
	);
	assert.equal(save.status, 200, await save.clone().text());
	assert.equal(
		(await db`SELECT revision FROM classifiers WHERE id=${original.id}`)[0]
			.revision,
		original.revision,
	);
	assert.equal(
		(
			await db`SELECT status FROM conversation_classifications WHERE classifier_id=${original.id}`
		)[0].status,
		"complete",
	);
});

test("already queued evaluations join progress without resetting the token or attempt", async () => {
	await reset();
	const thread = await email();
	await db`UPDATE classifiers SET enabled=true WHERE id=${classifier}`;
	const [old] =
		await db`INSERT INTO conversation_classifications(mailbox_id,thread_id,classifier_id,revision,generation,attempts) SELECT ${mailbox},${thread},${classifier},c.revision,v.generation,1 FROM classifiers c CROSS JOIN conversations v WHERE c.id=${classifier} AND v.mailbox_id=${mailbox} AND v.thread_id=${thread} RETURNING token`;
	const run = await start();
	await advanceBackfills(db);
	const [job] =
		await db`SELECT token,attempts,run_id FROM conversation_classifications WHERE thread_id=${thread}`;
	assert.equal(job.token, old.token);
	assert.equal(job.attempts, 1);
	assert.equal(job.run_id, run.id);
	await processJob(db, "test", job.token, yes);
	const [progress] = await (await call("/backfills")).json();
	assert.equal(progress.processed, 1);
	assert.equal(progress.pending, 0);
	assert.equal(progress.status, "completed");
});

test("tag-filtered runs freeze one scope, exclude other tags, and preserve manual corrections", async () => {
	await reset();
	const [tag] =
		await db`SELECT tag_id AS id FROM classifiers WHERE id=${classifier}`;
	const [otherTag] =
		await db`INSERT INTO tags(name,color) VALUES('Other topic','#123456') RETURNING id`;
	const [other] =
		await db`INSERT INTO classifiers(tag_id,question) VALUES(${otherTag.id},'Other topic?') RETURNING id`;
	const automatic = await email("Automatic"),
		manual = await email("Manual"),
		unrelated = await email("Unrelated"),
		removed = await email("Removed");
	for (const thread of [automatic, manual, removed])
		await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at) VALUES(${mailbox},${thread},${tag.id},${thread === manual ? "manual" : "classifier"},'test',${thread === removed ? new Date() : null})`;
	const input = {
		classifier_ids: [classifier, other.id],
		mailbox_ids: [mailbox],
		tag_id: tag.id,
		selection: "all",
	};
	const preview = await call("/backfills/preview", "POST", input);
	assert.equal((await preview.json()).count, 2);
	const response = await call("/backfills", "POST", input);
	assert.equal(response.status, 202, await response.clone().text());
	const runs = await response.json();
	assert.ok(runs.every((r: { prepared: boolean }) => r.prepared));
	assert.equal(
		(await db`SELECT count(*)::int n FROM classifier_run_items`)[0].n,
		4,
	);
	// Removal during processing must not shrink another classifier's scope.
	await db`UPDATE conversation_tags SET removed_at=now() WHERE thread_id=${automatic}`;
	await advanceBackfills(db);
	await advanceBackfills(db);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM conversation_classifications WHERE thread_id IN ${db([unrelated, removed])}`
		)[0].n,
		0,
	);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM conversation_classifications WHERE thread_id=${automatic}`
		)[0].n,
		2,
	);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM conversation_classifications WHERE thread_id=${manual} AND classifier_id=${classifier}`
		)[0].n,
		0,
	);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM classifier_run_items WHERE thread_id=${manual} AND skip_reason='manual'`
		)[0].n,
		1,
	);
	const invalid = await call("/backfills/preview", "POST", {
		...input,
		tag_id: crypto.randomUUID(),
	});
	assert.equal(invalid.status, 400);
});
