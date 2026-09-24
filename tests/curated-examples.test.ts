import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { createApi } from "../server/api";
import { InboxStore } from "../server/store";
import { exampleConfig } from "../shared/jev-examples";
import type { TagGroup } from "../shared/tag-groups";
import { curatedQuestion } from "../server/classification/curated-examples";
import { conversationState } from "../server/classification/state";
import { processJob } from "../server/classification/queue";
const schema = "test_curated_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db);
const mailbox = "examples@example.test";
let group: TagGroup;
const sent: unknown[] = [];
const app = createApi(db, {
	readAttachment: async () => null,
	classifiersEnabled: true,
	jevKey: "test",
	jevTransport: async (_url, init) => {
		const request = JSON.parse(String(init?.body));
		sent.push(request);
		return Response.json({
			answers: Object.fromEntries(
				Object.entries(request.questions).map(([key, q]) => {
					const question = q as {
						type: string;
						criteria: Record<string, string>;
					};
					if (question.type === "noul")
						return [key, { type: "noul", noul: 0.95 }];
					const options = Object.keys(question.criteria);
					return [
						key,
						{
							type: "choice",
							choice: group.tags[0].id,
							confidence: 0.95,
							probabilities: Object.fromEntries(
								options.map((o) => [
									o,
									o === group.tags[0].id ? 0.94 : 0.06 / (options.length - 1),
								]),
							),
						},
					];
				}),
			),
		});
	},
});
async function call(
	path: string,
	method = "GET",
	body?: unknown,
	target = app,
) {
	return target.request("http://127.0.0.1:4311/api/v1/classification" + path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}
async function message(text: string, box = mailbox) {
	const e = await store.insert(box, {
		sender: "customer@example.test",
		recipient: box,
		subject: text,
		body: "<p>" + text + "</p>",
	});
	return e!.thread_id!;
}
const target = () => ({ group_id: group.id, mailbox_id: mailbox });
// Create fixtures through the same inbox-only path, then exercise editing separately.
async function createFixture(body: {
	target: { group_id?: string; classifier_id?: string; mailbox_id: string };
	thread_id: string;
	value: { role: string; labels: string[]; config: string; note?: string };
}) {
	const { target, thread_id } = body;
	const [tag] = target.group_id
		? await db`SELECT id FROM tags WHERE group_id=${target.group_id} AND archived_at IS NULL ORDER BY position LIMIT 1`
		: await db`SELECT tag_id AS id FROM classifiers WHERE id=${target.classifier_id!}`;
	await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor) VALUES(${target.mailbox_id},${thread_id},${tag.id},'manual','fixture') ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET removed_at=NULL`;
	const created = await call("/examples/from-tags", "POST", {
		mailbox_id: target.mailbox_id,
		thread_id,
		tag_ids: [tag.id],
	});
	assert.equal(created.status, 200, await created.clone().text());
	await db`DELETE FROM conversation_tags WHERE mailbox_id=${target.mailbox_id} AND thread_id=${thread_id}`;
	const [e] =
		await db`SELECT id FROM jev_examples WHERE mailbox_id=${target.mailbox_id} AND thread_id=${thread_id} AND ${target.group_id ? db`group_id=${target.group_id}` : db`classifier_id=${target.classifier_id!}`}`;
	return call("/examples/" + e.id, "PUT", body);
}
async function add(
	thread: string,
	role = "teach",
	labels = [group.tags[0].id],
) {
	const r = await createFixture({
		target: target(),
		thread_id: thread,
		value: { role, labels, note: "Human reason", config: exampleConfig(group) },
	});
	assert.equal(r.status, 200, await r.clone().text());
	return r.json();
}
function draft() {
	return {
		name: group.name,
		selection: group.selection,
		instructions: group.instructions,
		enabled: group.enabled,
		revision: group.revision,
		tags: group.tags,
	};
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Examples");
	[group] = await db<
		TagGroup[]
	>`SELECT g.*,(SELECT json_agg(json_build_object('id',t.id,'name',t.name,'description',t.description,'color',t.color) ORDER BY position) FROM tags t WHERE group_id=g.id) AS tags FROM tag_groups g WHERE name='Urgency'`;
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
test("example labels are validated, mailbox-scoped and never assign inbox tags", async () => {
	const thread = await message("First teaching case");
	const e = await add(thread);
	assert.equal(e.role, "teach");
	assert.equal(e.state.messages[0].text, "First teaching case");
	assert.equal(
		(
			await createFixture({
				target: target(),
				thread_id: thread,
				value: { role: "teach", labels: [], config: exampleConfig(group) },
			})
		).status,
		400,
	);
	assert.equal(
		(
			await createFixture({
				target: target(),
				thread_id: thread,
				value: {
					role: "teach",
					labels: [crypto.randomUUID()],
					config: exampleConfig(group),
				},
			})
		).status,
		400,
	);
	assert.equal((await call("/examples", "POST", {})).status, 404);
	assert.equal(
		(await db`SELECT * FROM conversation_tags WHERE thread_id=${thread}`)
			.length,
		0,
	);
	const other = "other-examples@example.test";
	await store.createMailbox(other, "Other");
	const outside = await call(
		"/examples?" + new URLSearchParams({ ...target(), mailbox_id: other }),
	);
	assert.deepEqual((await outside.json()).examples, []);
	const member = createApi(db, {
		readAttachment: async () => null,
		classifiersEnabled: true,
		mode: "live",
		actor: "member@example.test",
		mailboxAdmins: ["admin@example.test"],
	});
	assert.equal(
		(
			await call(
				"/examples?" + new URLSearchParams(target()),
				"GET",
				undefined,
				member,
			)
		).status,
		403,
	);
});
test("frozen tests exclude held-out evidence and duplicate teaching conversations", async () => {
	const teachThread = await message("Unique teaching marker");
	await add(teachThread);
	const heldThread = await message("Held-out marker");
	const held = await add(heldThread, "test");
	await db`UPDATE emails SET body='Later reply changes everything' WHERE thread_id=${heldThread}`;
	const result = await call("/test", "POST", {
		mailbox_id: mailbox,
		thread_id: heldThread,
		example_id: held.id,
		group_id: group.id,
		group: draft(),
		questions: [{ name: "Unused", question: "Unused" }],
		execute: true,
	});
	assert.equal(result.status, 200);
	const body = await result.json();
	const request = body.results[0].request;
	assert.equal(request.state.messages[0].text, "Held-out marker");
	const instructions = Object.values(request.questions)
		.map((q) => (q as { instructions: string }).instructions)
		.join("");
	assert.match(instructions, /Unique teaching marker/);
	assert.doesNotMatch(instructions, /Held-out marker/);
	assert.doesNotMatch(JSON.stringify(request), /Later reply changes/);
	const duplicate = await message("Unique teaching marker");
	const q = await curatedQuestion(db, {
		target: target(),
		mailbox,
		thread: duplicate,
		state: await conversationState(db, mailbox, duplicate),
		group,
		question: "ignored",
	});
	assert.doesNotMatch(q.instructions, /Unique teaching marker/);
	const self = await curatedQuestion(db, {
		target: target(),
		mailbox,
		thread: teachThread,
		state: await conversationState(db, mailbox, teachThread),
		group,
		question: "ignored",
	});
	assert.doesNotMatch(self.instructions, /Unique teaching marker/);
});
test("configuration edits retain examples but exclude unreviewed labels", async () => {
	const thread = await message("Stale label case");
	const e = await add(thread);
	const revised = { ...group, instructions: "Changed definition" };
	const another = await message("New current case");
	const q = await curatedQuestion(db, {
		target: target(),
		mailbox,
		thread: another,
		state: await conversationState(db, mailbox, another),
		group: revised,
		question: "ignored",
	});
	assert.doesNotMatch(q.instructions, /Stale label case/);
	await db`UPDATE tag_groups SET instructions=${revised.instructions} WHERE id=${group.id}`;
	const rows = await call("/examples?" + new URLSearchParams(target()));
	assert.ok(
		(await rows.json()).examples.some((v: { id: string }) => v.id === e.id),
	);
	const stale = await call("/examples/" + e.id, "PUT", {
		target: target(),
		thread_id: thread,
		value: { role: "teach", labels: e.labels, config: exampleConfig(group) },
	});
	assert.equal(stale.status, 409);
	group = revised;
	const confirmed = await call("/examples/" + e.id, "PUT", {
		target: target(),
		thread_id: thread,
		value: { role: "teach", labels: e.labels, config: exampleConfig(group) },
	});
	assert.equal(confirmed.status, 200);
	assert.deepEqual((await confirmed.json()).state, e.state);
});
test("standalone curated labels compile as booleans and replace legacy examples", async () => {
	const [c] =
		await db`SELECT c.* FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.group_id IS NULL LIMIT 1`;
	const thread = await message("Standalone positive");
	const owner = { classifier_id: c.id, mailbox_id: mailbox };
	const r = await createFixture({
		target: owner,
		thread_id: thread,
		value: {
			role: "teach",
			labels: ["yes"],
			config: exampleConfig(undefined, c.question),
		},
	});
	assert.equal(r.status, 200);
	const current = await message("Another standalone");
	const q = await curatedQuestion(db, {
		target: owner,
		mailbox,
		thread: current,
		state: await conversationState(db, mailbox, current),
		question: c.question,
		option: c.tag_id,
		legacy: true,
	});
	assert.match(q.instructions, /"expected":true/);
	const negative = await call("/examples/" + (await r.json()).id, "PUT", {
		target: owner,
		thread_id: thread,
		value: {
			role: "test",
			labels: ["no"],
			config: exampleConfig(undefined, c.question),
		},
	});
	assert.equal(negative.status, 200);
	const without = await curatedQuestion(db, {
		target: owner,
		mailbox,
		thread: current,
		state: await conversationState(db, mailbox, current),
		question: c.question,
		legacy: true,
	});
	assert.doesNotMatch(without.instructions, /Standalone positive/);
});
test("production worker includes group teaching examples using the shared request builder", async () => {
	await db`UPDATE classifiers SET enabled=true WHERE tag_id IN (SELECT id FROM tags WHERE group_id=${group.id})`;
	await db`UPDATE tag_groups SET enabled=true WHERE id=${group.id}`;
	const thread = await message("Production pipeline fixture");
	const [job] =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${thread} LIMIT 1`;
	const requests: unknown[] = [];
	await processJob(db, "test", job.token, async (_u, init) => {
		const req = JSON.parse(String(init?.body));
		requests.push(req);
		return Response.json({
			answers: Object.fromEntries(
				Object.keys(req.questions).map((k) => [
					k,
					{
						type: "choice",
						choice: group.tags[0].id,
						confidence: 0.99,
						probabilities: Object.fromEntries(
							[...group.tags.map((t) => t.id), "insufficient_evidence"].map(
								(id) => [id, id === group.tags[0].id ? 0.94 : 0.02],
							),
						),
					},
				]),
			),
		});
	});
	assert.match(JSON.stringify(requests), /Stale label case/);
	assert.doesNotMatch(JSON.stringify(requests), /Held-out marker/);
	assert.equal(
		(
			await db`SELECT * FROM conversation_tags WHERE thread_id=${thread} AND removed_at IS NULL`
		).length,
		1,
	);
});
test("example removal is scoped and deletion cascades with its conversation", async () => {
	const thread = await message("Delete fixture");
	const e = await add(thread);
	const wrong = await call(
		"/examples/" +
			e.id +
			"?" +
			new URLSearchParams({
				...target(),
				mailbox_id: "other-examples@example.test",
			}),
		"DELETE",
	);
	assert.equal(wrong.status, 404);
	assert.equal(
		(
			await call(
				"/examples/" + e.id + "?" + new URLSearchParams(target()),
				"DELETE",
			)
		).status,
		204,
	);
	const other = await message("Cascade fixture");
	await add(other);
	await db`DELETE FROM emails WHERE mailbox_id=${mailbox} AND thread_id=${other}`;
	await db`DELETE FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${other}`;
	assert.equal(
		(await db`SELECT * FROM jev_examples WHERE thread_id=${other}`).length,
		0,
	);
});

test("multiple-selection examples support several labels and explicit no-tag cases", async () => {
	const [topic] = await db<
		TagGroup[]
	>`SELECT g.*,(SELECT json_agg(json_build_object('id',t.id,'name',t.name,'description',t.description,'color',t.color) ORDER BY position) FROM tags t WHERE group_id=g.id) AS tags FROM tag_groups g WHERE name='Topic'`;
	const thread = await message("No topic applies");
	const owner = { group_id: topic.id, mailbox_id: mailbox };
	const res = await createFixture({
		target: owner,
		thread_id: thread,
		value: { role: "teach", labels: [], config: exampleConfig(topic) },
	});
	assert.equal(res.status, 200);
	const current = await message("Multiple topics target");
	const q = await curatedQuestion(db, {
		target: owner,
		mailbox,
		thread: current,
		state: await conversationState(db, mailbox, current),
		group: topic,
		question: "Should this topic apply?",
		option: topic.tags[0].id,
	});
	assert.match(q.instructions, /"expected":false/);
	const saved = await res.json();
	const update = await call("/examples/" + saved.id, "PUT", {
		target: owner,
		thread_id: thread,
		value: {
			role: "teach",
			labels: [topic.tags[0].id, topic.tags[1].id],
			config: exampleConfig(topic),
		},
	});
	assert.equal(update.status, 200);
	const positive = await curatedQuestion(db, {
		target: owner,
		mailbox,
		thread: current,
		state: await conversationState(db, mailbox, current),
		group: topic,
		question: "Should this topic apply?",
		option: topic.tags[1].id,
	});
	assert.match(positive.instructions, /"expected":true/);
});
test("teaching selection balances labels, caps context and ignores cosmetic edits", async () => {
	for (let i = 0; i < 8; i++)
		await add(await message("Balance " + i), "teach", [
			group.tags[i < 5 ? 0 : 1].id,
		]);
	const current = await message("Budget target");
	const cosmetic = {
		...group,
		tags: group.tags.map((t) => ({ ...t, color: "#ffffff" })),
	};
	const state = await conversationState(db, mailbox, current);
	const q = await curatedQuestion(db, {
		target: target(),
		mailbox,
		thread: current,
		state,
		group: cosmetic,
		question: "ignored",
	});
	const evidence = JSON.parse(
		q.instructions.split("never these examples):\n")[1],
	);
	assert.equal(evidence.length, 6);
	assert.equal(
		evidence.filter(
			(e: { expected: string }) => e.expected === group.tags[0].id,
		).length,
		3,
	);
	const large = {
		...state,
		messages: [
			{ ...state.messages[0], text: "Long current conversation ".repeat(1000) },
		],
	};
	const noRoom = await curatedQuestion(db, {
		target: target(),
		mailbox,
		thread: current,
		state: large,
		group,
		question: "ignored",
	});
	assert.doesNotMatch(noRoom.instructions, /Historical human-labeled examples/);
});

test("one-click examples use assigned tags, skip empty groups and preserve held-out roles", async () => {
	const thread = await message("Save the current labels");
	const [topic] = await db<
		TagGroup[]
	>`SELECT g.*,(SELECT json_agg(json_build_object('id',t.id,'name',t.name,'description',t.description,'color',t.color) ORDER BY position) FROM tags t WHERE group_id=g.id) AS tags FROM tag_groups g WHERE name='Topic'`;
	const [standalone] =
		await db`SELECT c.id,c.tag_id FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.group_id IS NULL LIMIT 1`;
	const ids = [
		group.tags[0].id,
		topic.tags[0].id,
		topic.tags[1].id,
		standalone.tag_id,
	];
	for (const id of ids)
		await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor) VALUES(${mailbox},${thread},${id},'manual','test')`;
	const save = () =>
		call("/examples/from-tags", "POST", {
			mailbox_id: mailbox,
			thread_id: thread,
			tag_ids: ids,
		});
	const r = await save();
	assert.equal(r.status, 200, await r.clone().text());
	assert.equal((await r.json()).saved.length, 3);
	const rows = await db`SELECT * FROM jev_examples WHERE thread_id=${thread}`;
	assert.equal(rows.length, 3);
	assert.deepEqual(
		rows.find((e) => e.group_id === topic.id)!.labels,
		[topic.tags[0].id, topic.tags[1].id].sort(),
	);
	assert.deepEqual(
		rows.find((e) => e.classifier_id === standalone.id)!.labels,
		["yes"],
	);
	await db`UPDATE jev_examples SET role='test' WHERE thread_id=${thread}`;
	const stale = await call("/examples/from-tags", "POST", {
		mailbox_id: mailbox,
		thread_id: thread,
		tag_ids: ids.slice(1),
	});
	assert.equal(stale.status, 409);
	assert.equal((await save()).status, 200);
	const updated =
		await db`SELECT * FROM jev_examples WHERE thread_id=${thread}`;
	assert.equal(updated.length, 3);
	assert.ok(updated.every((e) => e.role === "test"));
	assert.equal(
		(
			await db`SELECT * FROM conversation_tags WHERE thread_id=${thread} AND removed_at IS NULL`
		).length,
		4,
	);
	const empty = await message("Unassigned groups are not negative examples");
	assert.equal(
		(
			await call("/examples/from-tags", "POST", {
				mailbox_id: mailbox,
				thread_id: empty,
				tag_ids: [],
			})
		).status,
		400,
	);
	assert.equal(
		(await db`SELECT * FROM jev_examples WHERE thread_id=${empty}`).length,
		0,
	);
});
