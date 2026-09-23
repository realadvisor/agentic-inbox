import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
	classifyThread,
	runClassifier,
	type ThreadMessage,
} from "../server/classifier";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
const example: ThreadMessage = {
	sender: "a@example.test",
	recipient: "info@realadvisor.com",
	cc: "",
	subject: "Help",
	body: "Can you help?",
	date: new Date(),
	delivery_status: "received",
};
const response =
	(confidence = 0.99): typeof fetch =>
	async () =>
		Response.json({
			model: "jev-test",
			answers: {
				reply: {
					type: "choice",
					choice: "reply_needed",
					confidence,
					probabilities: {
						reply_needed: confidence,
						no_reply_needed: 1 - confidence,
						needs_review: 0,
					},
				},
			},
		});
test("provider results are validated and uncertain or oversized context requires review", async () => {
	assert.equal(
		(
			await classifyThread(
				"info@ingest.realadvisor.com",
				[example],
				"fake",
				"jev-test",
				response(0.7),
			)
		).decision,
		"needs_review",
	);
	let calls = 0;
	const invalid: typeof fetch = async () => {
		calls++;
		return Response.json({});
	};
	assert.equal(
		(
			await classifyThread(
				"info@ingest.realadvisor.com",
				Array(31).fill(example),
				"fake",
				"jev-test",
				invalid,
			)
		).decision,
		"needs_review",
	);
	assert.equal(calls, 0);
	await assert.rejects(
		classifyThread(
			"info@ingest.realadvisor.com",
			[example],
			"fake",
			"jev-test",
			invalid,
		),
	);
});
const schema = "test_classifier_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const mailbox = "info@ingest.realadvisor.com";
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Info");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
async function insert(
	thread = crypto.randomUUID(),
	status = "received",
	folder = "inbox",
) {
	const id = crypto.randomUUID();
	await db`INSERT INTO emails(id,mailbox_id,folder_id,sender,recipient,body,thread_id,message_id,delivery_status) VALUES(${id},${mailbox},${folder},'a@example.test',${mailbox},'Can you help?',${thread},${id},${status})`;
	return thread;
}
async function state(thread: string) {
	return (
		await db`SELECT * FROM reply_classifications WHERE mailbox_id=${mailbox} AND thread_id=${thread}`
	)[0];
}
test("classification lifecycle, exclusions, stale results and manual corrections", async () => {
	const thread = await insert();
	await insert(undefined, "draft", "draft");
	await insert(undefined, "received", "spam");
	assert.equal(await runClassifier(db, "fake", "jev-test", response()), 1);
	assert.equal((await state(thread)).decision, "reply_needed");
	const generation = (await state(thread)).generation;
	await db`UPDATE emails SET read=true,starred=true WHERE thread_id=${thread}`;
	assert.equal((await state(thread)).generation, generation);
	await insert(thread, "sent", "sent");
	assert.equal((await state(thread)).decision, null);
	const api = createApi(db, { readAttachment: async () => null });
	const correct = (target: string, gen: string) =>
		api.request(
			`/api/v1/mailboxes/${mailbox}/threads/${target}/classification`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					decision: "no_reply_needed",
					generation: String(gen),
				}),
			},
		);
	await runClassifier(db, "fake", "jev-test", async () => {
		assert.equal(
			(await correct(thread, String((await state(thread)).generation))).status,
			200,
		);
		return response()!("https://example.test");
	});
	assert.equal((await state(thread)).decision, "no_reply_needed");
	assert.equal((await state(thread)).manual, true);
	assert.equal((await correct(thread, String(generation))).status, 409);
	assert.equal((await correct(crypto.randomUUID(), "1")).status, 409);
	assert.equal(
		(
			await store.list(mailbox, {
				reply_status: "no_reply_needed",
				folder: "inbox",
				threaded: "true",
			})
		).totalCount,
		1,
	);
	await insert(thread);
	await runClassifier(db, "fake", "jev-test", async () => {
		await insert(thread);
		return response()!("https://example.test");
	});
	assert.equal((await state(thread)).decision, null);
	for (let attempt = 0; attempt < 3; attempt++) {
		await db`UPDATE reply_classifications SET retry_at=now() WHERE thread_id=${thread}`;
		await runClassifier(
			db,
			"fake",
			"jev-test",
			async () => new Response("secret error", { status: 503 }),
		);
	}
	assert.equal((await state(thread)).decision, "needs_review");
	assert.equal((await state(thread)).last_error, "Typesafe HTTP 503");
	await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
	assert.equal((await db`SELECT * FROM reply_classifications`).length, 0);
});
