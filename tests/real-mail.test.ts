import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { ingest, type ObjectStore } from "../server/inbound";
import { sendReal } from "../server/outbound";
const schema = "test_live_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const mailbox = "privacy@ingest.realadvisor.com";
const blobs = new Map<string, ArrayBuffer>();
const objects: ObjectStore = {
	get: async (key) =>
		blobs.has(key) ? { arrayBuffer: async () => blobs.get(key)! } : null,
	put: async (key, value) => {
		blobs.set(
			key,
			typeof value === "string"
				? new TextEncoder().encode(value).buffer
				: value instanceof Uint8Array
					? value.slice().buffer
					: value,
		);
	},
};
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Privacy");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
function message(raw: string, to = mailbox) {
	return {
		to,
		from: "customer@example.test",
		raw: new Blob([raw]).stream(),
		rawSize: raw.length,
		setReject: (reason: string) => {
			throw new Error(reason);
		},
	};
}
test("MIME ingestion deduplicates retries and links replies within mailbox", async () => {
	const raw =
		"From: Customer <customer@example.test>\r\nTo: privacy@realadvisor.com\r\nMessage-ID: <inbound@example.test>\r\nSubject: Access request\r\n\r\nPlease provide my data";
	await Promise.all([
		ingest(message(raw), db, objects),
		ingest(message(raw), db, objects),
	]);
	const rows =
		await db`SELECT * FROM emails WHERE message_id='<inbound@example.test>'`;
	assert.equal(rows.length, 1);
	assert.match(rows[0].body, /provide my data/);
	assert.ok(blobs.has(rows[0].raw_storage_key));
	await ingest(
		message(
			raw.replace(
				"<inbound@example.test>",
				"<reply@example.test>\r\nIn-Reply-To: <inbound@example.test>",
			),
		),
		db,
		objects,
	);
	const [reply] =
		await db`SELECT * FROM emails WHERE message_id='<reply@example.test>'`;
	assert.equal(reply.thread_id, rows[0].thread_id);
	await assert.rejects(
		ingest(message(raw, "other@ingest.realadvisor.com"), db, objects),
		/Unknown mailbox/,
	);
});
test("send fixes sender identity and deduplicates requests", async () => {
	let calls = 0;
	const sender = {
		send: async (mail: { from: string }) => {
			calls++;
			assert.equal(mail.from, "privacy@realadvisor.com");
			return { messageId: "<outbound@example.test>" };
		},
	};
	const key = crypto.randomUUID();
	const input = {
		to: "customer@example.test",
		subject: "Re: Access request",
		text: "Real test",
	};
	const first = await sendReal(
		db,
		sender,
		mailbox,
		key,
		input,
		"jonas@realadvisor.com",
	);
	const second = await sendReal(
		db,
		sender,
		mailbox,
		key,
		input,
		"jonas@realadvisor.com",
	);
	assert.equal(calls, 1);
	assert.equal(first.id, second.id);
	assert.equal(first.status, "sent");
	await assert.rejects(
		sendReal(
			db,
			sender,
			mailbox,
			key,
			{ ...input, text: "different" },
			"jonas@realadvisor.com",
		),
		/different content/,
	);
});
test("ambiguous provider failure is recorded and never automatically resent", async () => {
	let calls = 0;
	const sender = {
		send: async () => {
			calls++;
			throw new Error("timeout");
		},
	};
	const key = crypto.randomUUID();
	const input = { to: "customer@example.test", subject: "Test", text: "test" };
	await assert.rejects(
		sendReal(db, sender, mailbox, key, input, "jonas@realadvisor.com"),
		/not confirmed/,
	);
	await assert.rejects(
		sendReal(db, sender, mailbox, key, input, "jonas@realadvisor.com"),
		/unknown/,
	);
	assert.equal(calls, 1);
});

test("only administrators create live mailboxes; new registered addresses receive and send", async () => {
	const { createApi } = await import("../server/api");
	const address = "dynamic-test@ingest.realadvisor.com";
	const opts = {
		mode: "live" as const,
		readAttachment: async () => null,
		origin: "https://inbox.example.test",
		mailboxCreationEnabled: true,
		mailboxAdmins: ["jonas@realadvisor.com"],
	};
	const create = (actor: string, email = address, enabled = true) =>
		createApi(db, { ...opts, actor, mailboxCreationEnabled: enabled }).request(
			"https://inbox.example.test/api/v1/mailboxes",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, name: "Dynamic test" }),
			},
		);
	assert.equal((await create("joan@realadvisor.com")).status, 403);
	assert.equal(
		(await create("jonas@realadvisor.com", address, false)).status,
		403,
	);
	for (const bad of [
		"boss@realadvisor.com",
		"other@untrusted.test",
		"a+b@ingest.realadvisor.com",
		"a".repeat(65) + "@ingest.realadvisor.com",
	])
		assert.equal((await create("jonas@realadvisor.com", bad)).status, 400);
	const results = await Promise.all([
		create("jonas@realadvisor.com"),
		create("jonas@realadvisor.com"),
	]);
	assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
	const [created] = await db`SELECT * FROM mailboxes WHERE id=${address}`;
	assert.equal(created.created_by, "jonas@realadvisor.com");
	assert.ok((await store.folders(address)).length > 0);
	const api = createApi(db, { ...opts, actor: "joan@realadvisor.com" });
	const listed = await (
		await api.request("https://inbox.example.test/api/v1/mailboxes")
	).json();
	assert.ok(listed.some((m: { id: string }) => m.id === address));
	assert.equal(
		(
			await (
				await api.request("https://inbox.example.test/api/v1/config")
			).json()
		).canCreateMailboxes,
		false,
	);
	await ingest(
		message(
			"From: Customer <customer@example.test>\r\nTo: dynamic-test@ingest.realadvisor.com\r\nMessage-ID: <dynamic@example.test>\r\nSubject: Dynamic\r\n\r\nHello",
			address,
		),
		db,
		objects,
	);
	assert.equal((await store.list(address, {})).totalCount, 1);
	let sends = 0;
	await sendReal(
		db,
		{
			send: async (mail) => {
				sends++;
				assert.equal(mail.from, "dynamic-test@realadvisor.com");
				assert.equal(mail.replyTo, mail.from);
				return { messageId: "<dynamic-sent@example.test>" };
			},
		},
		address,
		crypto.randomUUID(),
		{ to: "customer@example.test", text: "Hello", subject: "Reply" },
		"jonas@realadvisor.com",
	);
	assert.equal(sends, 1);
	const before = blobs.size;
	await assert.rejects(
		ingest(
			message("Subject: Unwanted\r\n\r\nno", "unknown@ingest.realadvisor.com"),
			db,
			objects,
		),
		/Unknown mailbox/,
	);
	assert.equal(blobs.size, before);
	await assert.rejects(
		sendReal(
			db,
			{
				send: async () => {
					throw new Error("must not call provider");
				},
			},
			"unknown@ingest.realadvisor.com",
			crypto.randomUUID(),
			{ to: "customer@example.test", subject: "Denied", text: "test" },
			"jonas@realadvisor.com",
		),
		/not enabled/,
	);
	assert.equal(
		(
			await api.request(
				"https://inbox.example.test/api/v1/mailboxes/" + address,
				{ method: "DELETE" },
			)
		).status,
		403,
	);
});
