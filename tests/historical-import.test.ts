import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
const schema = "test_history_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const mailbox = "history@example.test";
let tag: string;
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await db`INSERT INTO mailboxes(id,email,name) VALUES(${mailbox},${mailbox},'History test')`;
	await db`INSERT INTO folders(mailbox_id,id,name) VALUES(${mailbox},'inbox','Inbox'),(${mailbox},'archive','Archive'),(${mailbox},'sent','Sent')`;
	const [t] =
		await db`INSERT INTO tags(name,color) VALUES('History test','#3b82f6') RETURNING id`;
	tag = t.id;
	await db`INSERT INTO classifiers(tag_id,question,enabled) VALUES(${tag},'Needs reply?',true)`;
	await db`INSERT INTO agent_settings(mailbox_id,auto_draft) VALUES(${mailbox},true)`;
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
const email = (thread = crypto.randomUUID()) => ({
	id: crypto.randomUUID(),
	mailbox_id: mailbox,
	folder_id: "inbox",
	subject: "Synthetic history",
	sender: "sender@example.test",
	recipient: mailbox,
	thread_id: thread,
	message_id: crypto.randomUUID() + "@example.test",
	body: "Synthetic message",
	read: true,
	date: new Date("2021-08-03T12:00:00Z"),
});
test("import flag preserves constraints and suppresses jobs; normal delivery still works", async () => {
	const row = email();
	await db.begin(async (tx) => {
		await tx`SELECT set_config('inbox.historical_import','on',true)`;
		await tx`INSERT INTO emails ${tx(row)}`;
	});
	assert.equal((await db`SELECT * FROM conversations`).length, 1);
	assert.equal(
		(await db`SELECT * FROM conversation_classifications`).length,
		0,
	);
	assert.equal((await db`SELECT * FROM classifier_outbox`).length, 0);
	assert.equal((await db`SELECT * FROM agent_jobs`).length, 0);
	await assert.rejects(
		db.begin(async (tx) => {
			await tx`SELECT set_config('inbox.historical_import','on',true)`;
			await tx`INSERT INTO emails ${tx({ ...email(), folder_id: "not-real" })}`;
		}),
		/foreign key/,
	);
	await db`INSERT INTO emails ${db(email())}`;
	assert.equal(
		(await db`SELECT * FROM conversation_classifications`).length,
		1,
	);
	assert.equal((await db`SELECT * FROM classifier_outbox`).length, 1);
	assert.equal((await db`SELECT * FROM agent_jobs`).length, 1);
});
test("historical parent leaves existing resolved conversation and classifications unchanged", async () => {
	const row = email();
	await db`INSERT INTO emails ${db(row)}`;
	await db`UPDATE conversations SET status='done',updated_by='Human' WHERE thread_id=${row.thread_id}`;
	const before =
		await db`SELECT * FROM conversations WHERE thread_id=${row.thread_id}`;
	const jobs =
		await db`SELECT * FROM conversation_classifications WHERE thread_id=${row.thread_id}`;
	await db.begin(async (tx) => {
		await tx`SELECT set_config('inbox.historical_import','on',true)`;
		await tx`INSERT INTO emails ${tx({ ...email(row.thread_id), folder_id: "archive" })}`;
	});
	assert.deepEqual(
		await db`SELECT * FROM conversations WHERE thread_id=${row.thread_id}`,
		before,
	);
	assert.deepEqual(
		await db`SELECT * FROM conversation_classifications WHERE thread_id=${row.thread_id}`,
		jobs,
	);
	await db`INSERT INTO emails ${db(email(row.thread_id))}`;
	assert.equal(
		(
			await db`SELECT status FROM conversations WHERE thread_id=${row.thread_id}`
		)[0].status,
		"open",
	);
});
