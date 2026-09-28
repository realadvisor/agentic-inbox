import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { webhookApi } from "../server/webhooks/api";
const schema = "filter_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db),
	mailbox = "filters@example.test";
const app = webhookApi(db, { canManage: true, secretKey: "ab".repeat(32) });
before(async () => {
	await admin.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(db);
	await migrate(db);
	await store.createMailbox(mailbox, "Filters");
});
after(async () => {
	await db.end();
	await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await admin.end();
});
const call = (path: string, method = "GET", body?: unknown) =>
	app.request(`https://inbox.test/${mailbox}${path}`, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
async function tag() {
	const [t] =
		await db`INSERT INTO tags(name,color) VALUES(${crypto.randomUUID()},'#123456') RETURNING id`;
	return t.id as string;
}
async function message() {
	return (await store.insert(mailbox, {
		sender: "customer@example.test",
		recipient: mailbox,
		subject: "Test",
		body: "Hello",
		delivery_status: "received",
		folder_id: "inbox",
	}))!;
}
async function endpoint(
	include: string[],
	exclude: string[] = [],
	match = "any",
	events = ["conversation.matched"],
) {
	const r = await call("", "POST", {
		url: "https://hooks.example.com/inbox",
		events,
		include_tag_ids: include,
		exclude_tag_ids: exclude,
		tag_match: match,
	});
	assert.equal(r.status, 201, await r.clone().text());
	return (await r.json()).id as string;
}
async function assign(thread: string, id: string, add = true, tx = db) {
	await tx`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at) VALUES(${mailbox},${thread},${id},'manual','test',${add ? null : new Date()}) ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET removed_at=excluded.removed_at`;
}
async function deliveries(id: string) {
	return db`SELECT v.* FROM webhook_deliveries d JOIN webhook_events v ON v.id=d.event_id WHERE d.endpoint_id=${id} ORDER BY v.created_at`;
}

test("late tag assignment enters once, unrelated changes don't repeat, leave and re-enter sends a new event", async () => {
	const a = await tag(),
		b = await tag(),
		id = await endpoint([a]),
		m = await message();
	assert.equal((await deliveries(id)).length, 0);
	await assign(m.thread_id!, a);
	const first = await deliveries(id);
	assert.equal(first.length, 1);
	assert.equal(first[0].type, "conversation.matched");
	assert.deepEqual(first[0].payload.data.tag_ids, [a]);
	await assign(m.thread_id!, a);
	await assign(m.thread_id!, b);
	assert.equal((await deliveries(id)).length, 1);
	await assign(m.thread_id!, a, false);
	await assign(m.thread_id!, a);
	const again = await deliveries(id);
	assert.equal(again.length, 2);
	assert.notEqual(again[0].id, again[1].id);
});

test("all matching and exclusions use final transaction tags, avoiding intermediate false transitions", async () => {
	const a = await tag(),
		b = await tag(),
		spam = await tag(),
		id = await endpoint([a, b], [spam], "all"),
		m = await message();
	await db.begin(async (tx) => {
		await assign(m.thread_id!, a, true, tx as unknown as typeof db);
		await assign(m.thread_id!, b, true, tx as unknown as typeof db);
		await assign(m.thread_id!, spam, true, tx as unknown as typeof db);
	});
	assert.equal((await deliveries(id)).length, 0);
	await assign(m.thread_id!, spam, false);
	assert.equal((await deliveries(id)).length, 1);
	await db.begin(async (tx) => {
		await assign(m.thread_id!, a, false, tx as unknown as typeof db);
		await assign(m.thread_id!, a, true, tx as unknown as typeof db);
	});
	assert.equal((await deliveries(id)).length, 1);
});

test("classifier-applied tags enter without waiting for another received email", async () => {
	const a = await tag(),
		id = await endpoint([a]),
		m = await message();
	await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor) VALUES(${mailbox},${m.thread_id!},${a},'classifier','jev')`;
	assert.equal((await deliveries(id)).length, 1);
});

test("saving or enabling a filter establishes a baseline without backfilling", async () => {
	const a = await tag(),
		m = await message();
	await assign(m.thread_id!, a);
	const id = await endpoint([a]);
	assert.equal((await deliveries(id)).length, 0);
	const base = {
		url: "https://hooks.example.com/inbox",
		events: ["conversation.matched"],
		enabled: false,
	};
	assert.equal((await call(`/${id}`, "PUT", base)).status, 200);
	await assign(m.thread_id!, a, false);
	await assign(m.thread_id!, a);
	assert.equal(
		(await call(`/${id}`, "PUT", { ...base, enabled: true })).status,
		200,
	);
	await assign(m.thread_id!, a);
	assert.equal((await deliveries(id)).length, 0);
	await assign(m.thread_id!, a, false);
	await assign(m.thread_id!, a);
	assert.equal((await deliveries(id)).length, 1);
	const rows = await (await call("")).json();
	assert.deepEqual(
		rows.find((e: { id: string }) => e.id === id).include_tag_ids,
		[a],
	);
});

test("selected events are filtered at occurrence; unfiltered subscriptions still receive all events", async () => {
	const a = await tag(),
		filtered = await endpoint([a], [], "any", ["conversation.status_changed"]),
		all = await endpoint([], [], "any", ["conversation.status_changed"]),
		m = await message();
	await db`UPDATE conversations SET status='done' WHERE mailbox_id=${mailbox} AND thread_id=${m.thread_id!}`;
	assert.equal((await deliveries(filtered)).length, 0);
	assert.equal((await deliveries(all)).length, 1);
	await assign(m.thread_id!, a);
	await db`UPDATE conversations SET status='open' WHERE mailbox_id=${mailbox} AND thread_id=${m.thread_id!}`;
	assert.equal((await deliveries(filtered)).length, 1);
	assert.equal((await deliveries(all)).length, 2);
});

test("rejects invalid/contradictory filters, empty transition filters and unauthorized changes", async () => {
	const a = await tag();
	const body = {
		url: "https://hooks.example.com/inbox",
		events: ["conversation.matched"],
	};
	for (const filter of [
		{},
		{ include_tag_ids: [a], exclude_tag_ids: [a] },
		{ include_tag_ids: [crypto.randomUUID()] },
		{ include_tag_ids: ["not-uuid"] },
	])
		assert.equal((await call("", "POST", { ...body, ...filter })).status, 400);
	await db`UPDATE tags SET archived_at=now() WHERE id=${a}`;
	assert.equal(
		(await call("", "POST", { ...body, include_tag_ids: [a] })).status,
		400,
	);
	const denied = webhookApi(db, { canManage: false });
	assert.equal(
		(await denied.request(`https://inbox.test/${mailbox}`)).status,
		403,
	);
});

test("archiving an excluded tag can start a match; renaming included tags preserves matching", async () => {
	const a = await tag(),
		spam = await tag(),
		m = await message();
	await assign(m.thread_id!, a);
	await assign(m.thread_id!, spam);
	const id = await endpoint([a], [spam]);
	await db`UPDATE tags SET name='Renamed '||id::text WHERE id=${a}`;
	assert.equal((await deliveries(id)).length, 0);
	await db`UPDATE tags SET archived_at=now() WHERE id=${spam}`;
	assert.equal((await deliveries(id)).length, 1);
});

test("historical import updates the matching baseline without sending events", async () => {
	const a = await tag(),
		id = await endpoint([a]),
		m = await message();
	await db.begin(async (tx) => {
		await tx`SELECT set_config('inbox.historical_import','on',true)`;
		await assign(m.thread_id!, a, true, tx as unknown as typeof db);
	});
	assert.equal((await deliveries(id)).length, 0);
	await assign(m.thread_id!, a);
	assert.equal((await deliveries(id)).length, 0);
	await assign(m.thread_id!, a, false);
	await assign(m.thread_id!, a);
	assert.equal((await deliveries(id)).length, 1);
});

test("queued payload is a snapshot and test pings bypass tag filters", async () => {
	const a = await tag(),
		id = await endpoint([a]),
		m = await message();
	await assign(m.thread_id!, a);
	await assign(m.thread_id!, a, false);
	assert.deepEqual((await deliveries(id))[0].payload.data.tag_ids, [a]);
	assert.equal((await call(`/${id}/test`, "POST")).status, 202);
	assert.equal((await deliveries(id)).length, 2);
});

test("archived filter tags do not prevent disabling an existing endpoint", async () => {
	const a = await tag(),
		id = await endpoint([a]);
	await db`UPDATE tags SET archived_at=now() WHERE id=${a}`;
	const response = await call(`/${id}`, "PUT", {
		url: "https://hooks.example.com/inbox",
		events: ["conversation.matched"],
		enabled: false,
		include_tag_ids: [a],
	});
	assert.equal(response.status, 200);
	const [saved] =
		await db`SELECT enabled,include_tag_ids FROM webhook_endpoints WHERE id=${id}`;
	assert.equal(saved.enabled, false);
	assert.deepEqual(saved.include_tag_ids, [a]);
});
