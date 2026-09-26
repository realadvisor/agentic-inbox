import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { recipientSuggestions } from "../server/contacts";
import { createApi } from "../server/api";
import { readFile } from "node:fs/promises";

const schema = `test_contacts_${randomUUID().replaceAll("-", "")}`;
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const mailbox = "contacts@example.test";
const other = "other@example.test";
const api = createApi(db, { readAttachment: async () => null });
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Contacts");
	await store.createMailbox(other, "Other");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("indexes delivery transitions once, deduplicates recipients and excludes drafts and failures", async () => {
	const message = await store.insert(mailbox, {
		sender: mailbox,
		recipient: "Alice@example.test",
		cc: "alice@example.test, bob@example.test",
		bcc: "hidden@example.test",
		subject: "Test",
		body: "Test",
		delivery_status: "draft",
	});
	assert.ok(message);
	assert.equal((await recipientSuggestions(db, mailbox, "ali")).length, 0);
	await db`UPDATE emails SET delivery_status='sending' WHERE id=${message.id}`;
	assert.equal((await recipientSuggestions(db, mailbox, "ali")).length, 0);
	await db`UPDATE emails SET delivery_status='sent' WHERE id=${message.id}`;
	await db`UPDATE emails SET delivery_status='sent' WHERE id=${message.id}`;
	const contacts =
		await db`SELECT email,sent_count FROM mailbox_contacts WHERE mailbox_id=${mailbox} ORDER BY email`;
	assert.deepEqual(
		contacts.map((c) => [c.email, c.sent_count]),
		[
			["alice@example.test", 1],
			["bob@example.test", 1],
			["hidden@example.test", 1],
		],
	);
});

test("search is scoped, case-insensitive, literal, bounded and excludes selected recipients", async () => {
	await db`UPDATE mailbox_contacts SET name='Alice Cooper' WHERE email='alice@example.test' AND mailbox_id=${mailbox}`;
	await store.insert(other, {
		sender: "alice-private@example.test",
		recipient: other,
		subject: "Private",
		body: "",
	});
	assert.equal(
		(await recipientSuggestions(db, mailbox, "ALICE CO"))[0]?.email,
		"alice@example.test",
	);
	assert.deepEqual(
		[
			...(await recipientSuggestions(db, mailbox, "al", [
				"ALICE@example.test",
			])),
		],
		[],
	);
	assert.deepEqual([...(await recipientSuggestions(db, mailbox, "a%"))], []);
	assert.deepEqual([...(await recipientSuggestions(db, mailbox, "a"))], []);
	for (let i = 0; i < 8; i++)
		await store.insert(mailbox, {
			sender: `alice${i}@example.test`,
			recipient: mailbox,
			subject: "Test",
			body: "",
		});
	const found = await recipientSuggestions(db, mailbox, "ali");
	assert.equal(found.length, 5);
	assert.equal(found[0].email, "alice@example.test");
	assert.ok(!found.some((c) => c.email.includes("private")));
	const response = await api.request(
		`http://localhost/api/v1/mailboxes/${mailbox}/recipients?q=ALICE%20CO`,
	);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), [
		{ email: "alice@example.test", name: "Alice Cooper" },
	]);
	assert.equal(
		(
			await api.request(
				"http://localhost/api/v1/mailboxes/missing@example.test/recipients?q=al",
			)
		).status,
		404,
	);
});

test("ignores automated senders and mailbox itself, preserves newest interaction date", async () => {
	for (const sender of [
		mailbox,
		"no-reply@example.test",
		"mailer-daemon@example.test",
	])
		await store.insert(mailbox, {
			sender,
			recipient: mailbox,
			subject: "Auto",
			body: "",
		});
	assert.deepEqual([...(await recipientSuggestions(db, mailbox, "no-"))], []);
	assert.deepEqual(
		[...(await recipientSuggestions(db, mailbox, "contacts@"))],
		[],
	);
	const [before] =
		await db`SELECT last_used_at FROM mailbox_contacts WHERE mailbox_id=${mailbox} AND email='alice@example.test'`;
	await store.insert(mailbox, {
		sender: "alice@example.test",
		recipient: mailbox,
		subject: "Old",
		body: "",
		date: new Date("2020-01-01T00:00:00Z"),
	});
	const [after] =
		await db`SELECT last_used_at FROM mailbox_contacts WHERE mailbox_id=${mailbox} AND email='alice@example.test'`;
	assert.equal(+after.last_used_at, +before.last_used_at);
});

test("backfill produces the same counts as live indexing and migration is repeatable", async () => {
	const before =
		await db`SELECT mailbox_id,email,last_used_at,sent_count FROM mailbox_contacts ORDER BY mailbox_id,email`;
	await db`DROP TRIGGER maintain_mailbox_contacts ON emails`;
	await db`DROP FUNCTION maintain_mailbox_contacts()`;
	await db`DROP FUNCTION contact_addresses(emails)`;
	await db`DROP TABLE mailbox_contacts`;
	await db.unsafe(
		await readFile(
			new URL("../migrations/025_mailbox_contacts.sql", import.meta.url),
			"utf8",
		),
	);
	const after =
		await db`SELECT mailbox_id,email,last_used_at,sent_count FROM mailbox_contacts ORDER BY mailbox_id,email`;
	assert.deepEqual([...after], [...before]);
	await migrate(db);
	assert.equal(
		(await db`SELECT count(*)::int AS count FROM mailbox_contacts`)[0].count,
		after.length,
	);
});
