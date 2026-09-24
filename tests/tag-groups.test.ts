import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { createApi } from "../server/api";
import { InboxStore } from "../server/store";
import { setConversationTags } from "../server/tags";
import { processJob } from "../server/classification/queue";
import type { TagGroup } from "../shared/tag-groups";

const schema = "test_groups_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db);
const mailbox = "groups@example.test";
const app = createApi(db, {
	readAttachment: async () => null,
	classifiersEnabled: true,
});
const member = createApi(db, {
	readAttachment: async () => null,
	mode: "live",
	actor: "member@example.test",
	mailboxAdmins: ["admin@example.test"],
	classifiersEnabled: true,
});
async function call(
	path: string,
	method = "GET",
	body?: unknown,
	target = app,
) {
	return target.request("http://127.0.0.1:4311/api/v1" + path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
function input(group: TagGroup) {
	return {
		name: group.name,
		selection: group.selection,
		instructions: group.instructions,
		enabled: group.enabled,
		revision: group.revision,
		tags: group.tags.map(({ id, name, color }) => ({ id, name, color })),
	};
}
async function group(name = "Urgency"): Promise<TagGroup> {
	return (await (await call("/tag-groups")).json()).find(
		(g: TagGroup) => g.name === name,
	);
}
async function message() {
	const row = await store.insert(mailbox, {
		sender: "customer@example.test",
		recipient: mailbox,
		subject: "Please respond today",
		body: "Please respond today.",
	});
	assert.ok(row);
	return row.thread_id!;
}
async function classifyThread(
	thread: string,
	probability: (question: string) => number,
) {
	const [job] =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${thread} AND status='pending' LIMIT 1`;
	assert.ok(job);
	let calls = 0;
	await processJob(db, "test-key", job.token, async (_url, init) => {
		calls++;
		const body = JSON.parse(String(init?.body));
		const answers = Object.fromEntries(
			Object.entries(body.questions).map(([key, value]) => [
				key,
				{
					type: "noul",
					noul: probability((value as { instructions: string }).instructions),
				},
			]),
		);
		return Response.json({ model: "jev-test", answers });
	});
	return calls;
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await migrate(db);
	await store.createMailbox(mailbox, "Groups");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("groups extend the existing catalogue and classifiers with shared instructions", async () => {
	const original = await group();
	const body = input(original);
	body.enabled = true;
	body.instructions = "High for action today. Otherwise Medium or Low.";
	const saved = await call("/tag-groups/" + original.id, "PUT", body);
	assert.equal(saved.status, 200);
	const changed: TagGroup = await saved.json();
	const classifiers =
		await db`SELECT c.* FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.group_id=${original.id}`;
	assert.equal(classifiers.length, 3);
	assert.ok(
		classifiers.every(
			(c) =>
				c.enabled &&
				c.question.includes(body.instructions) &&
				c.question.includes("exactly one"),
		),
	);
	assert.equal(
		(await call("/tag-groups/" + original.id, "PUT", body)).status,
		409,
	);
	assert.equal(
		(await call("/tag-groups/" + original.id, "PUT", input(changed), member))
			.status,
		403,
	);
	assert.equal(
		(
			await call("/tags/" + changed.tags[0].id, "PUT", {
				name: "Bypass",
				color: "#2563eb",
			})
		).status,
		409,
	);
	assert.equal(
		(
			await call("/classification/classifiers/" + classifiers[0].id, "PUT", {
				tag_id: classifiers[0].tag_id,
				question: "Bypass",
				enabled: true,
				mailbox_ids: [],
				revision: classifiers[0].revision,
			})
		).status,
		409,
	);
});

test("Jev uses group criteria in the existing batch pipeline and manual reassignment persists", async () => {
	const g = await group(),
		thread = await message();
	assert.equal(
		await classifyThread(thread, (q) =>
			q.includes('Should "High"') ? 0.99 : 0.01,
		),
		1,
	);
	let tags = await store.tagsForThreads(mailbox, [thread]);
	assert.equal(tags.length, 1);
	assert.equal(tags[0].name, "High");
	assert.equal(tags[0].group_name, "Urgency");
	const low = g.tags.find((t) => t.name === "Low")!,
		medium = g.tags.find((t) => t.name === "Medium")!;
	await setConversationTags(db, mailbox, [thread], low.id, "add", "human");
	tags = await store.tagsForThreads(mailbox, [thread]);
	assert.equal(tags.length, 1);
	assert.equal(tags[0].id, low.id);
	assert.equal(tags[0].source, "manual");
	await store.insert(mailbox, {
		sender: "customer@example.test",
		recipient: mailbox,
		thread_id: thread,
		subject: "Followup",
		body: "Urgent again",
	});
	assert.equal(await classifyThread(thread, () => 0.99), 0);
	assert.equal((await store.tagsForThreads(mailbox, [thread]))[0].id, low.id);
	await Promise.all([
		setConversationTags(db, mailbox, [thread], medium.id, "add", "human"),
		setConversationTags(db, mailbox, [thread], low.id, "add", "human"),
	]);
	assert.equal((await store.tagsForThreads(mailbox, [thread])).length, 1);
});

test("contradictory single-select Jev results go to review instead of picking the last response", async () => {
	const thread = await message();
	await classifyThread(thread, () => 0.99);
	assert.equal((await store.tagsForThreads(mailbox, [thread])).length, 0);
	const rows =
		await db`SELECT status,error FROM conversation_classifications WHERE thread_id=${thread}`;
	assert.ok(
		rows.every(
			(row) => row.status === "review" && row.error === "group_conflict",
		),
	);
	assert.equal(
		(await store.list(mailbox, { needs_review: "true" })).emails.some(
			(email) => email.thread_id === thread,
		),
		true,
	);
	const logs =
		await db`SELECT i.disposition FROM classifier_provider_run_items i JOIN classifier_provider_runs r ON r.id=i.run_id WHERE r.thread_id=${thread}`;
	assert.ok(logs.every((row) => row.disposition === "review"));
});

test("renaming and retiring options preserve classifier history and reject duplicates", async () => {
	const g = await group("Topic"),
		body = input(g);
	const removed = g.tags[0];
	body.tags = body.tags.slice(1);
	body.tags[0].name = "Personal data";
	const saved = await call("/tag-groups/" + g.id, "PUT", body);
	assert.equal(saved.status, 200);
	const catalog = await (await call("/tags")).json();
	assert.ok(!catalog.some((t: { id: string }) => t.id === removed.id));
	const [old] =
		await db`SELECT archived_at,c.enabled FROM tags t JOIN classifiers c ON c.tag_id=t.id WHERE t.id=${removed.id}`;
	assert.ok(old.archived_at);
	assert.equal(old.enabled, false);
	const updated: TagGroup = await saved.json();
	const invalid = input(updated);
	invalid.tags[1].name = invalid.tags[0].name.toUpperCase();
	assert.equal((await call("/tag-groups/" + g.id, "PUT", invalid)).status, 400);
	assert.equal(
		(await call("/tag-groups/" + g.id, "PUT", { ...input(updated), tags: [] }))
			.status,
		400,
	);
});

test("a disabled group cannot be enabled through an individual classifier run", async () => {
	const importance = await group("Importance");
	const [classifier] =
		await db`SELECT id FROM classifiers WHERE tag_id=${importance.tags[0].id}`;
	const response = await call(
		`/classification/classifiers/${classifier.id}/runs`,
		"POST",
		{
			mailbox_ids: [mailbox],
			selection: "all",
			enable: true,
		},
	);
	assert.equal(response.status, 400);
	assert.match(await response.text(), /tag group/);
});

test("manual groups do not need instructions but Jev groups do", async () => {
	const input = {
		name: "Manual workflow",
		selection: "single",
		instructions: "",
		enabled: false,
		tags: [{ id: crypto.randomUUID(), name: "Later", color: "#2563eb" }],
	};
	const response = await call("/tag-groups", "POST", input);
	assert.equal(response.status, 201);
	const saved = await response.json();
	assert.equal(
		(
			await call("/tag-groups/" + saved.id, "PUT", {
				...input,
				revision: saved.revision,
				enabled: true,
			})
		).status,
		400,
	);
});
