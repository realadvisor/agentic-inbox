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
