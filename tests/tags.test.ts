import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import { ingest } from "../server/inbound";
import { sendReal } from "../server/outbound";

const schema = `test_tags_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const a = "tag-a@ingest.realadvisor.com";
const b = "tag-b@ingest.realadvisor.com";
const actor = "human@example.test";
const api = createApi(db, { readAttachment: async () => null, actor });
const prefix = (mailbox = a) => `/api/v1/mailboxes/${mailbox}`;
async function request(
	path: string,
	method = "GET",
	body?: unknown,
	target = api,
) {
	return target.request(`http://127.0.0.1:4311${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
async function tag() {
	const result = await request("/api/v1/tags", "POST", {
		name: `Tag ${crypto.randomUUID()}`,
		color: "#2563eb",
	});
	assert.equal(result.status, 201);
	return result.json();
}
async function message(mailbox = a, thread_id?: string) {
	const result = await store.insert(mailbox, {
		sender: "customer@example.test",
		recipient: mailbox,
		subject: "Synthetic tag request",
		body: "Synthetic body",
		thread_id,
	});
	assert.ok(result);
	return result;
}
const assignment = (thread: string, tag: string, mailbox = a) =>
	`${prefix(mailbox)}/threads/${thread}/tags/${tag}`;
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	// Verify backfill on an existing pre-tag schema, then migration idempotence.
	const { readFile } = await import("node:fs/promises");
	await db.unsafe(
		await readFile(
			new URL("../migrations/001_inbox.sql", import.meta.url),
			"utf8",
		),
	);
	await db`CREATE TABLE inbox_migrations (version integer PRIMARY KEY)`;
	await db`INSERT INTO inbox_migrations VALUES (1)`;
	await db`INSERT INTO mailboxes(id,email,name) VALUES (${a},${a},'A')`;
	await db`INSERT INTO folders(mailbox_id,id,name) VALUES (${a},'inbox','Inbox')`;
	await message();
	await migrate(db);
	await migrate(db);
	assert.equal(
		(await db`SELECT * FROM conversations WHERE mailbox_id=${a}`).length,
		1,
	);
	for (const folder of ["sent", "archive", "draft"])
		await db`INSERT INTO folders(mailbox_id,id,name) VALUES (${a},${folder},${folder})`;
	await store.createMailbox(b, "B");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("duplicate ingestion does not create phantom conversations", async () => {
	const m = await message();
	const before = (await db`SELECT * FROM conversations WHERE mailbox_id=${a}`)
		.length;
	await store.insert(a, {
		sender: m.sender,
		recipient: a,
		subject: m.subject,
		body: "Retry",
		message_id: m.message_id!,
	});
	assert.equal(
		(await db`SELECT * FROM conversations WHERE mailbox_id=${a}`).length,
		before,
	);
});

test("concurrent duplicate assignments, mailbox isolation and manual removal provenance", async () => {
	const t = await tag();
	const m = await message();
	const thread = m.thread_id!;
	const url = assignment(thread, t.id);
	const results = await Promise.all(
		Array.from({ length: 5 }, () => request(url, "PUT")),
	);
	assert.ok(results.every((r) => r.status === 204));
	let rows = await db`SELECT * FROM conversation_tags WHERE tag_id=${t.id}`;
	assert.equal(rows.length, 1);
	assert.equal(rows[0].actor, actor);
	assert.equal(rows[0].source, "manual");
	assert.equal((await request(assignment(thread, t.id, b), "PUT")).status, 404);
	assert.equal(
		(await request(assignment(thread, t.id, b), "DELETE")).status,
		404,
	);
	assert.equal((await store.list(b, { tag_id: t.id })).totalCount, 0);
	await message(b, thread); // Same thread UUID still has independent membership in B.
	assert.equal((await request(assignment(thread, t.id, b), "PUT")).status, 204);
	assert.equal((await request(url, "DELETE")).status, 204);
	assert.equal((await store.message(a, m.id)).tags.length, 0);
	assert.equal((await store.thread(b, thread))[0].tags[0].id, t.id);
	rows =
		await db`SELECT * FROM conversation_tags WHERE mailbox_id=${a} AND tag_id=${t.id}`;
	assert.equal(rows[0].source, "manual");
	assert.equal(rows[0].actor, actor);
	assert.ok(rows[0].removed_at);
	assert.ok(rows[0].updated_at >= rows[0].created_at);
	assert.equal((await request(url, "PUT")).status, 204);
	assert.equal((await store.message(a, m.id)).tags.length, 1);
	await assert.rejects(
		db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor) VALUES (${a},${crypto.randomUUID()},${t.id},'manual',${actor})`,
		{ code: "23503" },
	);
});

test("rename preserves stable references, delete requires confirmation and cascades active and removed assignments", async () => {
	const t = await tag();
	const m = await message();
	const n = await message(b);
	await request(assignment(m.thread_id!, t.id), "PUT");
	await request(assignment(n.thread_id!, t.id, b), "DELETE");
	const updated = await request(`/api/v1/tags/${t.id}`, "PUT", {
		name: "Renamed shared",
		color: "#ff0000",
	});
	assert.equal(updated.status, 200);
	assert.deepEqual(
		(await store.message(a, m.id)).tags.map(({ id, name, color }) => ({
			id,
			name,
			color,
		})),
		[{ id: t.id, name: "Renamed shared", color: "#ff0000" }],
	);
	assert.equal(
		(
			await request("/api/v1/tags", "POST", {
				name: " renamed shared ",
				color: "#123456",
			})
		).status,
		409,
	);
	assert.equal((await request(`/api/v1/tags/${t.id}`, "DELETE")).status, 400);
	assert.equal(
		(await request(`/api/v1/tags/${t.id}?confirm=true`, "DELETE")).status,
		204,
	);
	assert.equal(
		(await db`SELECT * FROM conversation_tags WHERE tag_id=${t.id}`).length,
		0,
	);
	assert.equal((await store.message(a, m.id)).tags.length, 0);
});

test("bulk is atomic, validates membership, rejects forged provenance and deduplicates threads", async () => {
	const t = await tag();
	const m = await message();
	const foreign = await message(b);
	const url = `${prefix()}/tags/bulk`;
	const input = { thread_ids: [m.thread_id], tag_id: t.id, action: "add" };
	assert.equal(
		(
			await request(url, "POST", {
				...input,
				thread_ids: [m.thread_id, foreign.thread_id],
			})
		).status,
		404,
	);
	assert.equal((await store.message(a, m.id)).tags.length, 0);
	assert.equal(
		(
			await request(url, "POST", {
				...input,
				source: "classifier",
				actor: "forged",
			})
		).status,
		400,
	);
	assert.equal(
		(
			await request(url, "POST", {
				...input,
				thread_ids: [m.thread_id, m.thread_id],
			})
		).status,
		204,
	);
	assert.equal(
		(await request(url, "POST", { ...input, action: "remove" })).status,
		204,
	);
	assert.equal(
		(await request(url, "POST", { ...input, thread_ids: [] })).status,
		400,
	);
	assert.equal(
		(await request(assignment(m.thread_id!, crypto.randomUUID()), "PUT"))
			.status,
		404,
	);
	assert.equal(
		(await request(`${prefix()}/emails?tag_id=invalid`)).status,
		400,
	);
	const live = createApi(db, {
		mode: "live",
		actor,
		readAttachment: async () => null,
	});
	await store.createMailbox("hidden@example.test", "Synthetic");
	const hidden = await message("hidden@example.test");
	assert.equal(
		(
			await request(
				assignment(hidden.thread_id!, t.id, "hidden@example.test"),
				"PUT",
				undefined,
				live,
			)
		).status,
		404,
	);
});

test("tag filtering precedes grouping/counting/pagination and combines with folder/search", async () => {
	const t = await tag();
	const ids: string[] = [];
	for (let i = 0; i < 4; i++) {
		const m = await message();
		ids.push(m.thread_id!);
		await message(a, m.thread_id!);
		await request(assignment(m.thread_id!, t.id), "PUT");
	}
	const pages = await Promise.all(
		[1, 2, 3].map(async (page) => {
			const res = await request(
				`${prefix()}/emails?folder=inbox&threaded=true&tag_id=${t.id}&limit=2&page=${page}`,
			);
			assert.equal(res.status, 200);
			return res.json();
		}),
	);
	assert.ok(pages.every((p) => p.totalCount === 4));
	assert.equal(pages[2].emails.length, 0);
	assert.equal(
		new Set(
			pages.flatMap((p) =>
				p.emails.map((e: { thread_id: string }) => e.thread_id),
			),
		).size,
		4,
	);
	assert.ok(
		pages[0].emails.every(
			(e: { tags: { id: string }[]; thread_count: number }) =>
				e.tags[0].id === t.id && e.thread_count === 2,
		),
	);
	const search = await (
		await request(
			`${prefix()}/search?threaded=true&tag_id=${t.id}&query=Synthetic`,
		)
	).json();
	assert.equal(search.totalCount, 4);
	assert.equal(
		(await store.list(a, { tag_id: t.id, query: "not present" })).totalCount,
		0,
	);
	assert.equal(
		(await store.list(a, { tag_id: t.id, folder: "archive" })).totalCount,
		0,
	);
});

test("tags persist across MIME ingestion, duplicate mail, replies, folder moves, archive and reconnect", async () => {
	const t = await tag();
	const removed = await tag();
	const m = await message();
	const thread = m.thread_id!;
	await request(assignment(thread, t.id), "PUT");
	await request(assignment(thread, removed.id), "DELETE");
	const raw = `From: customer@example.test\r\nTo: ${a}\r\nMessage-ID: <tags-new@example.test>\r\nIn-Reply-To: ${m.message_id}\r\nSubject: Follow-up\r\n\r\nNew synthetic message`;
	for (let i = 0; i < 2; i++)
		await ingest(
			{
				to: a,
				from: "customer@example.test",
				raw: new Blob([raw]).stream(),
				rawSize: raw.length,
				setReject: (reason) => {
					throw new Error(reason);
				},
			},
			db,
			{ get: async () => null, put: async () => {} },
		);
	await sendReal(
		db,
		{ send: async () => ({ messageId: "<tags-outbound@example.test>" }) },
		a,
		crypto.randomUUID(),
		{
			to: "customer@example.test",
			text: "Synthetic reply",
			subject: "Re: request",
		},
		actor,
		m.id,
		true,
	);
	const messages = await store.thread(a, thread);
	assert.equal(messages.length, 3);
	assert.ok(
		messages.every((e) => e.tags.length === 1 && e.tags[0].id === t.id),
	);
	for (const e of messages)
		assert.equal(
			(
				await request(`${prefix()}/emails/${e.id}/move`, "POST", {
					folderId: "archive",
				})
			).status,
			204,
		);
	const reconnected = connect(process.env.DATABASE_URL, schema);
	try {
		const result = await new InboxStore(reconnected).list(a, {
			tag_id: t.id,
			threaded: "true",
			folder: "archive",
		});
		assert.equal(result.totalCount, 1);
		assert.equal(result.emails[0].tags[0].id, t.id);
	} finally {
		await reconnected.end();
	}
	assert.ok(
		(
			await db`SELECT removed_at FROM conversation_tags WHERE mailbox_id=${a} AND tag_id=${removed.id}`
		)[0].removed_at,
	);
});
