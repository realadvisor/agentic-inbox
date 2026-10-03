import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { webhookApi } from "../server/webhooks/api";
import { deliverWebhook, publishWebhooks } from "../server/webhooks/delivery";
import {
	signature,
	encryptSecret,
	decryptSecret,
	validateDestination,
	validateUrl,
} from "../server/webhooks/security";
const schema = "webhooks_" + Date.now(),
	admin = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db),
	mailbox = "hooks@example.test",
	master = "ab".repeat(32);
const app = webhookApi(db, { canManage: true, secretKey: master });
before(async () => {
	await admin.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(db);
	await store.createMailbox(mailbox, "Hooks");
});
after(async () => {
	await db.end();
	await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await admin.end();
});
async function call(path: string, method = "GET", body?: unknown) {
	return app.request(
		"https://inbox.test/" + encodeURIComponent(mailbox) + path,
		{
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		},
	);
}
let endpoint: string, secret: string;
test("admin creates endpoint with one-time encrypted secret; other mailboxes cannot test it", async () => {
	const r = await call("", "POST", {
		url: "https://hooks.example.com/inbox",
		events: ["email.received", "conversation.classified"],
	});
	assert.equal(r.status, 201);
	const data = await r.json();
	endpoint = data.id;
	secret = data.secret;
	const [saved] =
		await db`SELECT secret FROM webhook_endpoints WHERE id=${endpoint}`;
	assert.notEqual(saved.secret, secret);
	assert.equal(await decryptSecret(saved.secret, master), secret);
	assert.equal(
		JSON.stringify(await (await call("")).json()).includes(secret),
		false,
	);
	const denied = webhookApi(db, { canManage: false, secretKey: master });
	assert.equal(
		(await denied.request("https://inbox.test/" + mailbox)).status,
		403,
	);
	assert.equal(
		(
			await app.request(
				`https://inbox.test/other@example.test/${endpoint}/test`,
				{ method: "POST" },
			)
		).status,
		400,
	);
});
test("email insertion atomically creates one event and delivery, excluding body", async () => {
	const id = crypto.randomUUID();
	await store.insert(mailbox, {
		id,
		thread_id: id,
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Test",
		body: "PRIVATE BODY",
		message_id: `<${id}@test>`,
		date: new Date(),
	});
	const rows =
		await db`SELECT * FROM webhook_events WHERE type='email.received'`;
	assert.equal(rows.length, 1);
	assert.equal(JSON.stringify(rows[0].payload).includes("PRIVATE BODY"), false);
	let published = 0;
	await publishWebhooks(db, {
		sendBatch: async (messages) => {
			published += messages.length;
		},
	});
	await publishWebhooks(db, {
		sendBatch: async (messages) => {
			published += messages.length;
		},
	});
	assert.equal(published, 1);
	const [d] =
		await db`SELECT id FROM webhook_deliveries WHERE event_id=${rows[0].id}`;
	let calls = 0;
	const send: typeof fetch = async (_url, init) => {
		calls++;
		const h = new Headers(init!.headers);
		assert.equal(
			h.get("X-Webhook-Signature"),
			await signature(
				secret,
				h.get("X-Webhook-Timestamp")!,
				String(init!.body),
			),
		);
		return new Response("OK");
	};
	const resolve = async (url: string) => new URL(url);
	await deliverWebhook(db, d.id, master, send, resolve);
	await deliverWebhook(db, d.id, master, send, resolve);
	assert.equal(calls, 1);
});
test("failed delivery retries 429, then succeeds; permanent 400 is visible and can be retried", async () => {
	const r = await call(`/${endpoint}/test`, "POST");
	const { id } = await r.json();
	const resolve = async (url: string) => new URL(url);
	assert.equal(
		await deliverWebhook(
			db,
			id,
			master,
			async () => new Response("busy", { status: 429 }),
			resolve,
		),
		30,
	);
	await db`UPDATE webhook_deliveries SET available_at=now() WHERE id=${id}`;
	await deliverWebhook(
		db,
		id,
		master,
		async () => new Response("bad", { status: 400 }),
		resolve,
	);
	assert.equal(
		(await db`SELECT status FROM webhook_deliveries WHERE id=${id}`)[0].status,
		"failed",
	);
	assert.equal(
		(await call(`/${endpoint}/deliveries/${id}/retry`, "POST")).status,
		202,
	);
	await deliverWebhook(db, id, master, async () => new Response("OK"), resolve);
	assert.equal(
		(await db`SELECT status FROM webhook_deliveries WHERE id=${id}`)[0].status,
		"success",
	);
	assert.equal(
		(
			await db`SELECT count(*)::int n FROM webhook_attempts WHERE delivery_id=${id}`
		)[0].n,
		3,
	);
});
test("URL checks reject private addresses and encrypted secrets reject the wrong key", async () => {
	for (const url of [
		"http://example.com",
		"https://127.0.0.1",
		"https://user:pass@example.com",
		"https://localhost",
		"https://example.com:8443",
	])
		assert.throws(() => validateUrl(url));
	await assert.rejects(
		validateDestination("https://hooks.example.com", async () =>
			Response.json({ Status: 0, Answer: [{ type: 1, data: "10.0.0.1" }] }),
		),
	);
	const encrypted = await encryptSecret("secret", master);
	await assert.rejects(decryptSecret(encrypted, "cd".repeat(32)));
});

test("transaction rollback cannot leak an event or delivery", async () => {
	const before = await db`SELECT count(*)::int n FROM webhook_events`;
	await assert.rejects(
		db.begin(async (tx) => {
			await tx`SELECT emit_inbox_webhook(${mailbox},'email.received','{"email_id":"rollback"}'::jsonb)`;
			throw new Error("rollback");
		}),
	);
	assert.equal(
		(await db`SELECT count(*)::int n FROM webhook_events`)[0].n,
		before[0].n,
	);
});

test("classification waits for every question and delivers only after tag changes commit", async () => {
	const [thread] =
		await db`SELECT thread_id,generation FROM conversations WHERE mailbox_id=${mailbox} LIMIT 1`;
	const classifiers =
		await db`SELECT id,revision,tag_id FROM classifiers LIMIT 2`;
	assert.equal(classifiers.length, 2);
	for (const c of classifiers)
		await db`INSERT INTO conversation_classifications(mailbox_id,thread_id,classifier_id,revision,generation,status,priority) VALUES(${mailbox},${thread.thread_id},${c.id},${c.revision},${thread.generation},'pending',2) ON CONFLICT(mailbox_id,thread_id,classifier_id) DO UPDATE SET status='pending',generation=excluded.generation`;
	const events = () =>
		db`SELECT id,payload FROM webhook_events WHERE type='conversation.classified' ORDER BY created_at`;
	await db`UPDATE conversation_classifications SET status='complete',answer=true,probability=0.99 WHERE mailbox_id=${mailbox} AND thread_id=${thread.thread_id} AND classifier_id=${classifiers[0].id}`;
	assert.equal(
		(await events()).length,
		0,
		"must wait for the remaining question",
	);
	await db.begin(async (tx) => {
		await tx`UPDATE conversation_classifications SET status='complete',answer=true,probability=0.99 WHERE mailbox_id=${mailbox} AND thread_id=${thread.thread_id} AND classifier_id=${classifiers[1].id}`;
		assert.equal(
			(
				await tx`SELECT id FROM webhook_events WHERE type='conversation.classified'`
			).length,
			0,
			"event must be deferred until commit",
		);
		for (const c of classifiers)
			await tx`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor) VALUES(${mailbox},${thread.thread_id},${c.tag_id},'classifier','jev') ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET removed_at=NULL`;
	});
	const rows = await events();
	assert.equal(rows.length, 1);
	assert.equal(rows[0].payload.data.results.length, 2);
	const [delivery] =
		await db`SELECT id FROM webhook_deliveries WHERE event_id=${rows[0].id}`;
	let sent = 0;
	await deliverWebhook(
		db,
		delivery.id,
		master,
		async (_url, init) => {
			sent++;
			assert.equal(init?.redirect, "error");
			assert.equal(JSON.parse(String(init?.body)).data.results.length, 2);
			const tags =
				await db`SELECT tag_id FROM conversation_tags WHERE mailbox_id=${mailbox} AND thread_id=${thread.thread_id} AND removed_at IS NULL`;
			for (const c of classifiers)
				assert.ok(
					tags.some((t) => t.tag_id === c.tag_id),
					"tag must already be visible when webhook is sent",
				);
			return new Response("OK");
		},
		async (url) => new URL(url),
	);
	assert.equal(sent, 1);

	await db`UPDATE conversation_classifications SET status='pending',token=gen_random_uuid() WHERE mailbox_id=${mailbox} AND thread_id=${thread.thread_id}`;
	await db`UPDATE conversation_classifications SET status='review' WHERE mailbox_id=${mailbox} AND thread_id=${thread.thread_id} AND classifier_id=${classifiers[0].id}`;
	assert.equal((await events()).length, 1);
	await db`UPDATE conversation_classifications SET status='error',error='provider_failed' WHERE mailbox_id=${mailbox} AND thread_id=${thread.thread_id} AND classifier_id=${classifiers[1].id}`;
	const finished = await events();
	assert.equal(finished.length, 2);
	assert.deepEqual(
		finished[1].payload.data.results
			.map((r: { status: string }) => r.status)
			.sort(),
		["error", "review"],
	);
});

test("tag deletion emits removal, but inserting an absent tag does not", async () => {
	await db`UPDATE webhook_endpoints SET events=array_append(events,'conversation.tags_changed') WHERE id=${endpoint}`;
	const [t] =
		await db`SELECT * FROM conversation_tags WHERE mailbox_id=${mailbox} AND removed_at IS NULL LIMIT 1`;
	assert.ok(t);
	await db`DELETE FROM conversation_tags WHERE mailbox_id=${mailbox} AND thread_id=${t.thread_id} AND tag_id=${t.tag_id}`;
	const rows =
		await db`SELECT payload FROM webhook_events WHERE type='conversation.tags_changed'`;
	assert.equal(rows.length, 1);
	assert.equal(rows[0].payload.data.action, "removed");
	await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at) VALUES(${mailbox},${t.thread_id},${t.tag_id},'classifier','jev',now())`;
	assert.equal(
		(
			await db`SELECT id FROM webhook_events WHERE type='conversation.tags_changed'`
		).length,
		1,
	);
});

test("Worker connection creates, lists and updates webhook arrays", async () => {
	const workerDb = postgres(process.env.DATABASE_URL!, {
		fetch_types: false,
		connection: { search_path: schema },
	});
	try {
		const workerApp = webhookApi(workerDb, {
			canManage: true,
			secretKey: master,
		});
		const request = (path: string, method = "GET", body?: unknown) =>
			workerApp.request("https://inbox.test/" + mailbox + path, {
				method,
				headers: { "content-type": "application/json" },
				body: body ? JSON.stringify(body) : undefined,
			});
		const created = await request("", "POST", {
			url: "https://hooks.example.com/worker",
			events: ["email.received", "conversation.classified"],
		});
		assert.equal(created.status, 201);
		const { id } = await created.json();
		const list = await (await request("")).json();
		const saved = list.find((row: { id: string }) => row.id === id);
		assert.deepEqual(saved.events, [
			"email.received",
			"conversation.classified",
		]);
		assert.deepEqual(saved.include_tag_ids, []);
		assert.deepEqual(saved.exclude_tag_ids, []);
		assert.equal(
			(
				await request("/" + id, "PUT", {
					url: "https://hooks.example.com/worker",
					events: ["email.sent"],
					enabled: false,
				})
			).status,
			200,
		);
		const [tag] =
			await db`INSERT INTO tags(name,color) VALUES('Worker filter','#123456') RETURNING id`;
		assert.equal(
			(
				await request("/" + id, "PUT", {
					url: "https://hooks.example.com/worker",
					events: ["conversation.matched"],
					include_tag_ids: [tag.id],
					exclude_tag_ids: [],
					enabled: false,
				})
			).status,
			200,
		);
		assert.equal(
			(
				await request("/" + id, "PUT", {
					url: "https://hooks.example.com/renamed",
					events: ["conversation.matched"],
					enabled: false,
				})
			).status,
			200,
		);
		const filtered = (await (await request("")).json()).find(
			(row: { id: string }) => row.id === id,
		);
		assert.deepEqual(filtered.include_tag_ids, [tag.id]);
		assert.deepEqual(filtered.events, ["conversation.matched"]);

		assert.equal((await request("/" + id, "DELETE")).status, 200);
	} finally {
		await workerDb.end();
	}
});

test("Invalid encryption configuration returns a setup error", async () => {
	const misconfigured = webhookApi(db, {
		canManage: true,
		secretKey: "invalid",
	});
	const r = await misconfigured.request("https://inbox.test/" + mailbox, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			url: "https://hooks.example.com/test",
			events: ["email.received"],
		}),
	});
	assert.equal(r.status, 503);
	assert.match((await r.json()).error, /WEBHOOK_SECRET_KEY/);
});
