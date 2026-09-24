import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import { getThreadWorkflow } from "../server/thread-status";

const schema = `test_status_${randomUUID().replaceAll("-", "")}`;
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const api = createApi(db, { readAttachment: async () => null });
const mailbox = "status@example.test";
const other = "other@example.test";
const message = (subject = "Status") =>
	store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject,
		body: "Original",
	});
async function request(thread: string, body?: unknown, target = mailbox) {
	return api.request(
		`http://127.0.0.1:4311/api/v1/mailboxes/${target}/threads/${thread}/status`,
		{
			method: body ? "PUT" : "GET",
			headers: { "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
		},
	);
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Status");
	await store.createMailbox(other, "Other");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("backfills existing threads as open without inferring status from folders or read flags", async () => {
	const oldSchema = `${schema}_old`;
	await admin`CREATE SCHEMA ${admin(oldSchema)}`;
	const old = connect(process.env.DATABASE_URL, oldSchema);
	try {
		await old`CREATE TABLE inbox_migrations (version integer PRIMARY KEY)`;
		for (const filename of (
			await readdir(new URL("../migrations/", import.meta.url))
		)
			.filter((name) => name.endsWith(".sql") && Number(name.slice(0, 3)) < 18)
			.sort()) {
			await old.unsafe(
				await readFile(
					new URL(`../migrations/${filename}`, import.meta.url),
					"utf8",
				),
			);
			await old`INSERT INTO inbox_migrations VALUES (${Number(filename.slice(0, 3))})`;
		}
		const oldStore = new InboxStore(old);
		await oldStore.createMailbox(mailbox, "Old inbox");
		const email = await oldStore.insert(mailbox, {
			sender: mailbox,
			recipient: mailbox,
			subject: "Archived",
			body: "Old",
			read: true,
			folder_id: "archive",
		});
		assert.ok(email);
		await migrate(old);
		await migrate(old);
		const state = await getThreadWorkflow(old, mailbox, email.thread_id!);
		assert.equal(state.status, "open");
		assert.equal(state.activity.length, 0);
		assert.equal(
			(await oldStore.message(mailbox, email.id)).folder_id,
			"archive",
		);
	} finally {
		await old.end();
		await admin`DROP SCHEMA ${admin(oldSchema)} CASCADE`;
	}
});

test("status persists per conversation, filters before pagination, and leaves messages unchanged", async () => {
	const email = await message("Filter status");
	assert.ok(email);
	const thread = email.thread_id!;
	const initial = await getThreadWorkflow(db, mailbox, thread);
	assert.equal(initial.status, "open");
	const result = await request(thread, {
		status: "done",
		revision: initial.revision,
		reason: "Completed request",
	});
	assert.equal(result.status, 200);
	const reconnect = connect(process.env.DATABASE_URL, schema);
	try {
		const state = await getThreadWorkflow(reconnect, mailbox, thread);
		assert.equal(state.status, "done");
		assert.equal(state.activity[0].reason, "Completed request");
		assert.equal(state.follow_up_at, null);
		assert.equal(state.activity[0].actor, "local-synthetic-user");
		assert.equal(state.activity[0].follow_up_at, null);
	} finally {
		await reconnect.end();
	}
	const list = await store.list(mailbox, {
		folder: "inbox",
		threaded: "true",
		status: "done",
		query: "Filter status",
		limit: "1",
	});
	assert.equal(list.totalCount, 1);
	assert.equal(list.emails[0].thread_status, "done");
	const persisted = await store.message(mailbox, email.id);
	assert.equal(persisted.read, false);
	assert.equal(persisted.folder_id, "inbox");
	assert.equal(
		(await request(thread, { status: "done", revision: initial.revision }))
			.status,
		409,
	);
	assert.equal(
		(await request(thread, { status: "done", revision: initial.revision + 1 }))
			.status,
		200,
	);
	const done = await getThreadWorkflow(db, mailbox, thread);
	assert.equal(done.waiting_reason, null);
	assert.equal(done.follow_up_at, null);
	assert.equal(
		(await request(thread, { status: "open", revision: done.revision })).status,
		200,
	);
});

test("incoming replies reopen, duplicate ingestion does not reopen, and stale completion is rejected", async () => {
	const email = await message();
	assert.ok(email);
	const thread = email.thread_id!;
	let state = await getThreadWorkflow(db, mailbox, thread);
	await request(thread, { status: "done", revision: state.revision });
	state = await getThreadWorkflow(db, mailbox, thread);
	const incoming = {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "New question",
		body: "One more thing",
		thread_id: thread,
		message_id: `<${randomUUID()}@example.test>`,
	};
	await store.insert(mailbox, incoming);
	const reopened = await getThreadWorkflow(db, mailbox, thread);
	assert.equal(reopened.status, "open");
	assert.equal(reopened.activity[0].reason, "New incoming message");
	assert.equal(
		(await request(thread, { status: "done", revision: state.revision }))
			.status,
		409,
	);
	await request(thread, { status: "done", revision: reopened.revision });
	const closed = await getThreadWorkflow(db, mailbox, thread);
	assert.equal(await store.insert(mailbox, incoming), null);
	assert.deepEqual(await getThreadWorkflow(db, mailbox, thread), closed);
});

test("drafts and outgoing replies preserve status; simultaneous status changes cannot overwrite", async () => {
	const email = await message();
	assert.ok(email);
	const thread = email.thread_id!;
	const state = await getThreadWorkflow(db, mailbox, thread);
	const concurrent = await Promise.all([
		request(thread, { status: "done", revision: state.revision }),
		request(thread, {
			status: "open",
			revision: state.revision,
		}),
	]);
	assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
	const before = await getThreadWorkflow(db, mailbox, thread);
	for (const delivery of ["draft", "simulated"] as const)
		await store.insert(mailbox, {
			sender: mailbox,
			recipient: "sender@example.test",
			subject: "Reply",
			body: "Reply",
			thread_id: thread,
			delivery_status: delivery,
			folder_id: delivery === "draft" ? "draft" : "sent",
		});
	const after = await getThreadWorkflow(db, mailbox, thread);
	assert.equal(after.status, before.status);
	assert.equal(after.activity.length, before.activity.length);
	// Race ingestion and a status change: either completion is rejected, or the reply reopens it.
	await Promise.all([
		request(thread, { status: "done", revision: after.revision }),
		store.insert(mailbox, {
			sender: "sender@example.test",
			recipient: mailbox,
			subject: "Race",
			body: "New",
			thread_id: thread,
		}),
	]);
	assert.equal((await getThreadWorkflow(db, mailbox, thread)).status, "open");
});

test("retiring Waiting reopens existing threads once and preserves history", async () => {
	const legacySchema = `${schema}_waiting`;
	await admin`CREATE SCHEMA ${admin(legacySchema)}`;
	const legacy = connect(process.env.DATABASE_URL, legacySchema);
	try {
		await legacy`CREATE TABLE inbox_migrations (version integer PRIMARY KEY)`;
		for (const filename of (
			await readdir(new URL("../migrations/", import.meta.url))
		)
			.filter((name) => name.endsWith(".sql") && Number(name.slice(0, 3)) < 19)
			.sort()) {
			await legacy.unsafe(
				await readFile(
					new URL(`../migrations/${filename}`, import.meta.url),
					"utf8",
				),
			);
			await legacy`INSERT INTO inbox_migrations VALUES (${Number(filename.slice(0, 3))})`;
		}
		const legacyStore = new InboxStore(legacy);
		await legacyStore.createMailbox(mailbox, "Legacy waiting");
		const email = await legacyStore.insert(mailbox, {
			sender: mailbox,
			recipient: mailbox,
			subject: "Waiting",
			body: "Example",
		});
		assert.ok(email);
		await legacy`UPDATE conversations SET status='waiting', waiting_reason='Reply', follow_up_at=now()+interval '1 day' WHERE mailbox_id=${mailbox} AND thread_id=${email.thread_id!}`;
		await migrate(legacy);
		await migrate(legacy);
		const state = await getThreadWorkflow(legacy, mailbox, email.thread_id!);
		assert.equal(state.status, "open");
		assert.equal(state.follow_up_at, null);
		assert.equal(state.waiting_reason, null);
		assert.equal(state.activity.length, 1);
		assert.equal(state.activity[0].from_status, "waiting");
		assert.equal(state.activity[0].reason, "Waiting status removed");
		await assert.rejects(
			legacy`UPDATE conversations SET status='waiting', waiting_reason='Reply' WHERE mailbox_id=${mailbox}`,
		);
	} finally {
		await legacy.end();
		await admin`DROP SCHEMA ${admin(legacySchema)} CASCADE`;
	}
});

test("mailbox isolation and invalid transitions fail without modifying state", async () => {
	const email = await message();
	assert.ok(email);
	const thread = email.thread_id!;
	const state = await getThreadWorkflow(db, mailbox, thread);
	assert.equal((await request(thread, undefined, other)).status, 404);
	assert.equal(
		(await request(thread, { status: "done", revision: state.revision }, other))
			.status,
		404,
	);
	for (const invalid of [
		{ status: "waiting", revision: state.revision },
		{ status: "waiting", revision: state.revision, reason: " " },
		{
			status: "open",
			revision: state.revision,
			followUpAt: "invalid",
		},
		{
			status: "open",
			revision: state.revision,
			followUpAt: "2020-01-01T00:00:00Z",
		},
		{
			status: "done",
			revision: state.revision,
			followUpAt: new Date(Date.now() + 3600000).toISOString(),
		},
		{ status: "done" },
		{ status: "classified", revision: state.revision },
		{ status: "done", revision: state.revision, actor: "Jev" },
	])
		assert.equal((await request(thread, invalid)).status, 400);
	assert.deepEqual(await getThreadWorkflow(db, mailbox, thread), state);
});

test("history uses the authenticated actor and preserves tags and classifier generation", async () => {
	const email = await message();
	assert.ok(email);
	const thread = email.thread_id!;
	const [before] =
		await db`SELECT generation FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${thread}`;
	const identityApi = createApi(db, {
		actor: "jonas@example.test",
		readAttachment: async () => null,
	});
	const state = await getThreadWorkflow(db, mailbox, thread);
	const response = await identityApi.request(
		`http://127.0.0.1:4311/api/v1/mailboxes/${mailbox}/threads/${thread}/status`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "done", revision: state.revision }),
		},
	);
	assert.equal(response.status, 200);
	assert.equal(
		(await getThreadWorkflow(db, mailbox, thread)).activity[0].actor,
		"jonas@example.test",
	);
	const [after] =
		await db`SELECT generation FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${thread}`;
	assert.equal(after.generation, before.generation);
});
