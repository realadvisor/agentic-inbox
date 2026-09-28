import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect, type Database } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { classificationTools } from "../server/agent/classification-tools";
import { createTools, type Run } from "../server/agent/service";
import { inspectClassifications } from "../server/classification/inspect";
import { createApi } from "../server/api";
const schema = `test_classification_tools_${randomUUID().replaceAll("-", "")}`;
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db),
	mailbox = "classification@example.test";
const options = { toolCallId: "test", messages: [] };
const run: Run = {
	id: randomUUID(),
	mailbox,
	actor: "operator@example.test",
	prompt: "Review",
	classification: { enabled: true, admin: true },
};
const tools = (r = run) =>
	classificationTools(db, r, (_name, callback) =>
		db.begin((tx) => callback(tx as unknown as Database)),
	);
async function fixture(selection?: "single" | "score") {
	const email = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Question",
		body: "Hello",
	});
	const thread = email!.thread_id!;
	const [group] = selection
		? await db`INSERT INTO tag_groups(name,selection,instructions) VALUES(${randomUUID()},${selection},'Classify importance') RETURNING id`
		: [];
	const [tag] =
		await db`INSERT INTO tags(name,color,group_id) VALUES(${randomUUID()},'#2563eb',${group?.id ?? null}) RETURNING id`;
	const [classifier] =
		await db`INSERT INTO classifiers(tag_id,question,enabled) VALUES(${tag.id},'Does this need attention?',true) RETURNING id,revision`;
	const [job] =
		await db`INSERT INTO conversation_classifications(mailbox_id,thread_id,classifier_id,revision,generation,status,probability,score,confidence) SELECT ${mailbox},${thread},${classifier.id},1,generation,'review',0.6,${selection === "score" ? 1.2 : null},${selection === "score" ? 0.7 : null} FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${thread} RETURNING token`;
	return { thread, tag: tag.id, classifier: classifier.id, token: job.token };
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Classification");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
test("inspection scopes current results and exposes scale metadata without provider logs", async () => {
	const f = await fixture("score");
	const result = await inspectClassifications(db, mailbox, f.thread);
	const row = result.results.find((r) => r.classifier_id === f.classifier)!;
	assert.equal(row.score, 1.2);
	assert.equal(row.confidence, 0.7);
	assert.equal(row.selection, "score");
	assert.ok(row.levels.length);
	assert.equal(row.response_body, undefined);
	await assert.rejects(
		inspectClassifications(db, "other@example.test", f.thread),
		/not found/,
	);
	await db`UPDATE conversation_classifications SET generation=generation-1 WHERE classifier_id=${f.classifier}`;
	assert.equal(
		(await inspectClassifications(db, mailbox, f.thread)).results.length,
		0,
	);
});
test("agent correction uses explicit provenance, stale token fails, rerun protects it and no human example is created", async () => {
	const f = await fixture();
	const input = {
		threadId: f.thread,
		classifierId: f.classifier,
		answer: true,
		revision: 1,
		token: f.token,
	};
	await tools().review_classification.execute!(input, options);
	const [row] =
		await db`SELECT source,actor,answer FROM conversation_classifications WHERE classifier_id=${f.classifier}`;
	assert.equal(row.source, "agent");
	assert.equal(row.actor, run.actor);
	assert.equal(row.answer, true);
	assert.equal(
		(
			await db`SELECT * FROM classifier_examples WHERE classifier_id=${f.classifier}`
		).length,
		0,
	);
	await assert.rejects(
		tools().review_classification.execute!(input, options) as Promise<unknown>,
		/changed/,
	);
	await tools().rerun_classification.execute!({ threadId: f.thread }, options);
	assert.equal(
		(
			await db`SELECT source FROM conversation_classifications WHERE classifier_id=${f.classifier}`
		)[0].source,
		"agent",
	);
});
test("choice/score cannot be coerced to boolean; manual overrides are protected", async () => {
	for (const selection of ["single", "score"] as const) {
		const f = await fixture(selection);
		await assert.rejects(
			tools().review_classification.execute!(
				{
					threadId: f.thread,
					classifierId: f.classifier,
					answer: true,
					revision: 1,
					token: f.token,
				},
				options,
			) as Promise<unknown>,
			/explicit tag selection/,
		);
	}
	const f = await fixture();
	await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor) VALUES(${mailbox},${f.thread},${f.tag},'manual','human')`;
	await assert.rejects(
		tools().review_classification.execute!(
			{
				threadId: f.thread,
				classifierId: f.classifier,
				answer: true,
				revision: 1,
				token: f.token,
			},
			options,
		) as Promise<unknown>,
		/manual override/,
	);
});
test("rerun requires server capability; disabled and automatic runs cannot use tools", async () => {
	const f = await fixture();
	await assert.rejects(
		tools({ ...run, classification: { enabled: true, admin: false } })
			.rerun_classification.execute!(
			{ threadId: f.thread },
			options,
		) as Promise<unknown>,
		/administrators/,
	);
	await assert.rejects(
		tools({ ...run, classification: { enabled: false, admin: true } })
			.inspect_classifications.execute!(
			{ threadId: f.thread },
			options,
		) as Promise<unknown>,
		/unavailable/,
	);
	assert.equal(
		"inspect_classifications" in
			createTools(db, { ...run, automatic: true }, () => {}),
		false,
	);
});
test("API exposes the same bounded inspection and review validations", async () => {
	const f = await fixture();
	const api = createApi(db, {
		readAttachment: async () => null,
		classifiersEnabled: true,
	});
	const response = await api.request(
		`/api/v1/classification/threads/${mailbox}/${f.thread}/classifications`,
	);
	assert.equal(response.status, 200);
	assert.equal((await response.json()).thread_id, f.thread);
	const stale = await api.request(
		`/api/v1/classification/results/${mailbox}/${f.thread}/${f.classifier}`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ answer: true, revision: 99, token: f.token }),
		},
	);
	assert.equal(stale.status, 409);
});

test("agent corrections reject human reviews, stale generations and other mailboxes", async () => {
	const f = await fixture();
	const input = {
		threadId: f.thread,
		classifierId: f.classifier,
		answer: false,
		revision: 1,
		token: f.token,
	};
	await assert.rejects(
		tools({ ...run, mailbox: "other@example.test" }).review_classification
			.execute!(input, options) as Promise<unknown>,
		/changed/,
	);
	await db`UPDATE conversation_classifications SET source='human' WHERE classifier_id=${f.classifier}`;
	await assert.rejects(
		tools().review_classification.execute!(input, options) as Promise<unknown>,
		/Human-reviewed/,
	);
	await db`UPDATE conversation_classifications SET source='jev',generation=generation-1 WHERE classifier_id=${f.classifier}`;
	await assert.rejects(
		tools().review_classification.execute!(input, options) as Promise<unknown>,
		/changed/,
	);
});
