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
			Object.entries(body.questions).map(([key, value]) => {
				const q = value as {
					type: string;
					instructions: string;
					criteria: Record<string, string>;
				};
				if (q.type !== "choice")
					return [key, { type: "noul", noul: probability(q.instructions) }];
				const weights = Object.fromEntries(
					Object.entries(q.criteria).map(([id, description]) => [
						id,
						id === "insufficient_evidence"
							? 0
							: probability(
									`Should ${JSON.stringify(description.split(":")[0])}`,
								),
					]),
				);
				const total = Object.values(weights).reduce((a, b) => a + b, 0);
				const probabilities = Object.fromEntries(
					Object.entries(weights).map(([id, v]) => [id, v / total]),
				);
				const ranked = Object.entries(probabilities).sort(
					(a, b) => b[1] - a[1],
				);
				return [
					key,
					{
						type: "choice",
						choice: ranked[0][0],
						confidence: ranked[0][1] > 0.75 ? 0.9 : 0.1,
						probabilities,
					},
				];
			}),
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

test("ambiguous Choice probabilities send every group option to review", async () => {
	const thread = await message();
	await classifyThread(thread, () => 0.99);
	assert.equal((await store.tagsForThreads(mailbox, [thread])).length, 0);
	const rows =
		await db`SELECT status,error FROM conversation_classifications WHERE thread_id=${thread}`;
	assert.ok(rows.every((row) => row.status === "review" && row.error === null));
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

test("unsaved Jev tests preview exact evidence and leave classification state untouched", async () => {
	const thread = await message();
	await db`INSERT INTO emails(id,folder_id,message_id,mailbox_id,thread_id,sender,recipient,subject,body,delivery_status) VALUES(${crypto.randomUUID()},'inbox',${crypto.randomUUID()},${mailbox},${thread},${mailbox},'customer@example.test','Draft','DRAFT MUST NOT LEAK','draft')`;
	const before =
		await db`SELECT * FROM conversation_tags WHERE mailbox_id=${mailbox} AND thread_id=${thread}`;
	const jobsBefore =
		await db`SELECT * FROM conversation_classifications WHERE mailbox_id=${mailbox} AND thread_id=${thread} ORDER BY classifier_id`;
	let calls = 0;
	const target = createApi(db, {
		readAttachment: async () => null,
		classifiersEnabled: true,
		jevKey: "test",
		jevTransport: async (_url, init) => {
			calls++;
			const body = JSON.parse(String(init?.body));
			assert.equal(body.state.messages.length, 1);
			assert.ok(!JSON.stringify(body).includes("DRAFT MUST NOT LEAK"));
			assert.ok(
				body.questions.match.instructions.includes("Unsaved instruction"),
			);
			return Response.json({
				answers: { match: { type: "noul", noul: 0.93 } },
			});
		},
	});
	const body = {
		mailbox_id: mailbox,
		thread_id: thread,
		questions: [{ name: "Urgent", question: "Unsaved instruction" }],
	};
	const preview = await call("/classification/test", "POST", body, target);
	assert.equal(preview.status, 200);
	assert.equal(calls, 0);
	const snapshot = await preview.json();
	assert.equal(snapshot.results[0].request.state.messages.length, 1);
	const run = await call(
		"/classification/test",
		"POST",
		{ ...body, execute: true },
		target,
	);
	assert.equal(run.status, 200);
	const result = await run.json();
	assert.equal(calls, 1);
	assert.equal(result.results[0].result.answer, true);
	assert.ok(result.results[0].request.state.evaluated_at);
	result.results[0].request.state.evaluated_at =
		snapshot.results[0].request.state.evaluated_at;
	assert.deepEqual(result.results[0].request, snapshot.results[0].request);
	assert.deepEqual(
		await db`SELECT * FROM conversation_tags WHERE mailbox_id=${mailbox} AND thread_id=${thread}`,
		before,
	);
	const jobs =
		await db`SELECT * FROM conversation_classifications WHERE mailbox_id=${mailbox} AND thread_id=${thread} ORDER BY classifier_id`;
	assert.deepEqual(jobs, jobsBefore);
	assert.equal(
		(await call("/classification/test", "POST", body, member)).status,
		403,
	);
	assert.equal(
		(await call("/classification/test", "POST", { ...body, execute: true }))
			.status,
		503,
	);
	assert.equal(
		(
			await call(
				"/classification/test",
				"POST",
				{ ...body, mailbox_id: "missing@example.test" },
				target,
			)
		).status,
		404,
	);
	const failed = createApi(db, {
		readAttachment: async () => null,
		classifiersEnabled: true,
		jevKey: "test",
		jevTransport: async () => Response.json({}, { status: 429 }),
	});
	const failure = await (
		await call(
			"/classification/test",
			"POST",
			{ ...body, execute: true },
			failed,
		)
	).json();
	assert.equal(failure.results[0].error, "provider_http_429");
});

test("deleting a group retires tags and cancels work while keeping run history", async () => {
	const body = {
		...input(await group()),
		name: "Delete test",
		tags: [
			{ id: crypto.randomUUID(), name: "Delete option", color: "#2563eb" },
		],
		enabled: true,
		instructions: "Choose this tag",
	};
	const created = await (await call("/tag-groups", "POST", body)).json();
	const thread = await message();
	await setConversationTags(
		db,
		mailbox,
		[thread],
		created.tags[0].id,
		"add",
		"human",
	);
	const [classifier] =
		await db`SELECT id,revision FROM classifiers WHERE tag_id=${created.tags[0].id}`;
	const [run] =
		await db`INSERT INTO classifier_runs(classifier_id,revision,actor) VALUES(${classifier.id},${classifier.revision},'tester') RETURNING id`;
	await db`INSERT INTO classifier_run_items(run_id,mailbox_id,thread_id) VALUES(${run.id},${mailbox},${thread})`;
	const path = `/tag-groups/${created.id}?confirm=true&revision=${created.revision}`;
	assert.equal((await call(path, "DELETE", undefined, member)).status, 403);
	assert.equal(
		(
			await call(
				`/tag-groups/${created.id}?revision=${created.revision}`,
				"DELETE",
			)
		).status,
		400,
	);
	assert.equal(
		(
			await call(
				`/tag-groups/${created.id}?confirm=true&revision=999`,
				"DELETE",
			)
		).status,
		409,
	);
	assert.equal((await call(path, "DELETE")).status, 204);
	assert.equal(
		(await db`SELECT id FROM tag_groups WHERE id=${created.id}`).length,
		0,
	);
	const [retired] =
		await db`SELECT t.archived_at,t.group_id,c.enabled FROM tags t JOIN classifiers c ON c.tag_id=t.id WHERE t.id=${created.tags[0].id}`;
	assert.ok(retired.archived_at);
	assert.equal(retired.group_id, null);
	assert.equal(retired.enabled, false);
	assert.equal(
		(
			await db`SELECT * FROM conversation_tags WHERE tag_id=${created.tags[0].id}`
		).length,
		0,
	);
	assert.equal(
		(
			await db`SELECT * FROM conversation_classifications WHERE classifier_id=${classifier.id}`
		).length,
		0,
	);
	assert.equal(
		(await db`SELECT status FROM classifier_runs WHERE id=${run.id}`)[0].status,
		"cancelled",
	);
	assert.equal(
		(
			await db`SELECT status FROM classifier_run_items WHERE run_id=${run.id}`
		)[0].status,
		"skipped",
	);
	assert.equal((await call(path, "DELETE")).status, 404);
});

test("unsaved group tests send one Choice and preserve descriptions without saving", async () => {
	const thread = await message();
	const draft = {
		name: "Unsaved routing",
		selection: "single" as const,
		enabled: false,
		instructions: "Select the outstanding request's urgency.",
		tags: [
			{
				id: crypto.randomUUID(),
				name: "Routine",
				description: "No time-sensitive action.",
				color: "#2563eb",
			},
			{
				id: crypto.randomUUID(),
				name: "Immediate",
				description: "Reply today to avoid missing a commitment.",
				color: "#dc2626",
			},
		],
	};
	let count = 0;
	const target = createApi(db, {
		readAttachment: async () => null,
		classifiersEnabled: true,
		jevKey: "test",
		jevTransport: async (_url, init) => {
			count++;
			const payload = JSON.parse(String(init?.body));
			assert.equal(Object.keys(payload.questions).length, 1);
			const [key, q] = Object.entries(payload.questions)[0] as [
				string,
				{ type: string; criteria: Record<string, string> },
			];
			assert.equal(q.type, "choice");
			assert.equal(
				q.criteria[draft.tags[1].id],
				"Immediate: Reply today to avoid missing a commitment.",
			);
			assert.equal(payload.state.messages[0].text, "Please respond today.");
			return Response.json({
				model: "test",
				answers: {
					[key]: {
						type: "choice",
						choice: draft.tags[1].id,
						confidence: 0.95,
						probabilities: {
							[draft.tags[0].id]: 0.01,
							[draft.tags[1].id]: 0.98,
							insufficient_evidence: 0.01,
						},
					},
				},
			});
		},
	});
	const body = {
		mailbox_id: mailbox,
		thread_id: thread,
		group: draft,
		questions: [
			{ name: "ignored", question: "ignored; server compiles group" },
		],
	};
	const preview = await (
		await call("/classification/test", "POST", body, target)
	).json();
	assert.equal(count, 0);
	assert.equal(
		new Set(
			preview.results.map((r: { request: unknown }) =>
				JSON.stringify(r.request),
			),
		).size,
		1,
	);
	const result = await (
		await call(
			"/classification/test",
			"POST",
			{ ...body, execute: true },
			target,
		)
	).json();
	assert.equal(count, 1);
	assert.equal(result.results[0].result.answer, false);
	assert.equal(result.results[1].result.answer, true);
	assert.deepEqual(
		result.results[0].request.questions,
		preview.results[0].request.questions,
	);
	assert.equal(
		(await db`SELECT id FROM tag_groups WHERE name=${draft.name}`).length,
		0,
	);
	assert.equal(
		(
			await db`SELECT tag_id FROM conversation_tags WHERE tag_id IN ${db(draft.tags.map((t) => t.id))}`
		).length,
		0,
	);
});
