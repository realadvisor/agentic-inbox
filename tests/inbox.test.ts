import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import { localAttachments } from "../server/local-attachments";

const schema = `test_inbox_${randomUUID().replaceAll("-", "")}`;
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const directory = await mkdtemp(join(tmpdir(), "inbox-attachments-"));
const api = createApi(db, { readAttachment: localAttachments(directory) });
const a = "privacy@example.test";
const b = "info@example.test";
const prefix = (mailbox = a) => `/api/v1/mailboxes/${mailbox}`;
async function request(path: string, method = "GET", body?: unknown) {
	return api.request(`http://127.0.0.1:4311${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await migrate(db);
	await store.createMailbox(a, "Privacy");
	await store.createMailbox(b, "Info");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
	await rm(directory, { recursive: true, force: true });
});

test("duplicate ingestion is atomic and scoped to a mailbox", async () => {
	const input = {
		sender: "alex@example.test",
		recipient: a,
		subject: "Delete my data",
		body: "<p>Please delete my data</p>",
		message_id: "<same@example.test>",
	};
	const inserted = await Promise.all([
		store.insert(a, input),
		store.insert(a, input),
	]);
	assert.equal(inserted.filter(Boolean).length, 1);
	assert.ok(await store.insert(b, { ...input, recipient: b }));
	const [count] =
		await db`SELECT count(*)::int AS n FROM emails WHERE message_id = '<same@example.test>'`;
	assert.equal(count.n, 2);
});

test("cross-mailbox reads, updates, threads and attachments cannot leak", async () => {
	const row = await store.insert(a, {
		sender: "private@example.test",
		recipient: a,
		subject: "Private",
		body: "Private body",
	});
	assert.ok(row);
	const attachmentId = randomUUID();
	await writeFile(join(directory, attachmentId), "synthetic attachment");
	await db`INSERT INTO attachments VALUES (${attachmentId}, ${a}, ${row.id}, 'sample.txt', 'text/plain', 20, ${attachmentId})`;
	assert.equal((await request(`${prefix(b)}/emails/${row.id}`)).status, 404);
	assert.equal(
		(await request(`${prefix(b)}/emails/${row.id}`, "PUT", { read: true }))
			.status,
		404
	);
	assert.deepEqual(
		await (await request(`${prefix(b)}/threads/${row.thread_id}`)).json(),
		[]
	);
	assert.equal(
		(await request(`${prefix(b)}/emails/${row.id}/attachments/${attachmentId}`))
			.status,
		404
	);
	assert.equal(
		await (
			await request(`${prefix()}/emails/${row.id}/attachments/${attachmentId}`)
		).text(),
		"synthetic attachment"
	);
});

test("reply is simulated, persisted, and threaded; plain text is escaped", async () => {
	const parent = await store.insert(a, {
		sender: "reply@example.test",
		recipient: a,
		subject: "Reply test",
		body: "Original",
	});
	assert.ok(parent);
	const response = await request(
		`${prefix()}/emails/${parent.id}/reply`,
		"POST",
		{
			to: "reply@example.test",
			subject: "Re: Reply test",
			text: "<script>sample</script>",
		}
	);
	assert.equal(response.status, 201);
	const result = await response.json();
	assert.equal(result.status, "simulated");
	const thread = await store.thread(a, parent.thread_id ?? parent.id);
	assert.equal(thread.length, 2);
	const reply = thread.find((message) => message.id === result.id);
	assert.equal(reply?.folder_id, "sent");
	assert.equal(reply?.delivery_status, "simulated");
	assert.equal(reply?.in_reply_to, parent.message_id);
	assert.equal(reply?.body, "&lt;script&gt;sample&lt;/script&gt;");
	const reconnect = connect(process.env.DATABASE_URL, schema);
	try {
		assert.equal(
			(await new InboxStore(reconnect).message(a, result.id)).subject,
			"Re: Reply test"
		);
	} finally {
		await reconnect.end();
	}
});

test("draft saves update the same row and cannot overwrite an inbox message", async () => {
	const response = await request(`${prefix()}/drafts`, "POST", {
		body: "Draft 1",
	});
	assert.equal(response.status, 201);
	const { draft_id } = await response.json();
	assert.equal(
		(await request(`${prefix()}/drafts`, "POST", { body: "Draft 2", draft_id }))
			.status,
		200
	);
	assert.equal((await store.message(a, draft_id)).body, "Draft 2");
	assert.equal(
		(
			await request(`${prefix(b)}/drafts`, "POST", {
				body: "overwrite",
				draft_id,
			})
		).status,
		404
	);
	const parent = await store.insert(a, {
		sender: a,
		recipient: a,
		subject: "Immutable",
		body: "Original",
	});
	assert.ok(parent);
	assert.equal(
		(
			await request(`${prefix()}/drafts`, "POST", {
				body: "overwrite",
				draft_id: parent.id,
			})
		).status,
		404
	);
});

test("search, paging, flags, folders and deletion use persisted Postgres data", async () => {
	const email = await store.insert(a, {
		sender: "needle@example.test",
		recipient: a,
		subject: "Searchable 100%",
		body: "Unusual content",
	});
	assert.ok(email);
	assert.equal(
		(await request(`${prefix()}/emails/${email.id}`, "PUT", { starred: true }))
			.status,
		200
	);
	const found = await store.list(a, {
		from: "needle",
		is_starred: "true",
		query: "100%",
		page: "1",
		limit: "1",
	});
	assert.equal(found.totalCount, 1);
	assert.equal(found.emails[0].id, email.id);
	const folder = await (
		await request(`${prefix()}/folders`, "POST", { name: "Review" })
	).json();
	assert.equal(
		(
			await request(`${prefix()}/emails/${email.id}/move`, "POST", {
				folderId: folder.id,
			})
		).status,
		204
	);
	assert.equal((await store.message(a, email.id)).folder_id, folder.id);
	assert.equal(
		(await request(`${prefix()}/folders/${folder.id}`, "DELETE")).status,
		409
	);
	assert.equal(
		(await request(`${prefix()}/emails/${email.id}`, "DELETE")).status,
		204
	);
	assert.equal(
		(await request(`${prefix()}/folders/${folder.id}`, "DELETE")).status,
		204
	);
	assert.equal(
		(await request(`${prefix()}/folders/inbox`, "DELETE")).status,
		409
	);
});

test("invalid requests and non-local origins fail without touching mail", async () => {
	assert.equal((await request(`${prefix()}/emails/not-a-uuid`)).status, 400);
	assert.equal((await request(`${prefix()}/emails?page=-1`)).status, 400);
	assert.equal(
		(await request(`${prefix()}/search?date_start=invalid`)).status,
		400
	);
	assert.equal(
		(
			await request(`${prefix()}/emails`, "POST", {
				to: "invalid",
				text: "test",
			})
		).status,
		400
	);
	assert.equal((await api.request("http://evil.test/api/health")).status, 403);
	assert.equal(
		(
			await api.request("http://127.0.0.1:4311/api/health", {
				headers: { Origin: "https://evil.test" },
			})
		).status,
		403
	);
});
