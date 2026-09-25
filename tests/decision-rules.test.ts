import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import {
	decisionRulesSchema,
	defaultDecisionRules,
} from "../shared/decision-rules";
import {
	interpretAnswer,
	jevQuestion,
	groupChoice,
} from "../shared/jev-request";
import { exampleConfig } from "../shared/jev-examples";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { createApi } from "../server/api";
import { InboxStore } from "../server/store";
import { processJob } from "../server/classification/queue";
import type { TagGroup } from "../shared/tag-groups";

test("decision thresholds validate boundaries and preserve legacy defaults", () => {
	assert.deepEqual(decisionRulesSchema.parse({}), defaultDecisionRules);
	assert.equal(
		decisionRulesSchema.safeParse({ yes: 0.2, no: 0.3 }).success,
		false,
	);
	assert.equal(
		decisionRulesSchema.safeParse({ confidence: 1.1 }).success,
		false,
	);
	const q = jevQuestion("Apply?");
	assert.equal(interpretAnswer(q, { type: "noul", noul: 0.7 }).answer, null);
	assert.equal(
		interpretAnswer(q, { type: "noul", noul: 0.7 }, undefined, { yes: 0.7 })
			.answer,
		true,
	);
	assert.equal(
		interpretAnswer(q, { type: "noul", noul: 0.25 }, undefined, { no: 0.25 })
			.answer,
		false,
	);
});
const schema = "test_rules_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const mailbox = "rules@example.test";
const transport: typeof fetch = async (_url, init) => {
	const request = JSON.parse(String(init?.body));
	assert.ok(!String(init?.body).includes("decision_rules"));
	return Response.json({
		answers: Object.fromEntries(
			Object.entries(request.questions).map(([key, value]) => {
				const q = value as { type: string; criteria: Record<string, unknown> };
				if (q.type === "noul") return [key, { type: "noul", noul: 0.7 }];
				const options = Object.keys(q.criteria).filter(
					(k) => k !== "insufficient_evidence",
				);
				return [
					key,
					{
						type: "choice",
						choice: options[0],
						confidence: 0.7,
						probabilities: {
							[options[0]]: 0.65,
							[options[1]]: 0.35,
							insufficient_evidence: 0,
						},
					},
				];
			}),
		),
	});
};
const app = createApi(db, {
	readAttachment: async () => null,
	classifiersEnabled: true,
	jevKey: "fake",
	jevTransport: transport,
});
async function call(path: string, method = "GET", body?: unknown) {
	return app.request("http://127.0.0.1:4311/api/v1" + path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await new InboxStore(db).createMailbox(mailbox, "Rules");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
test("saved group rules govern production, audit and draft tests without relabeling examples", async () => {
	const rules = {
		...defaultDecisionRules,
		probability: 0.6,
		confidence: 0.65,
		margin: 0.25,
	};
	const response = await call("/tag-groups", "POST", {
		name: "Rule test",
		selection: "single",
		instructions: "Pick the matching category.",
		enabled: true,
		decision_rules: rules,
		tags: ["A", "B"].map((name) => ({
			id: crypto.randomUUID(),
			name,
			color: "#64748b",
		})),
	});
	assert.equal(response.status, 201);
	const group = (await response.json()) as TagGroup;
	assert.deepEqual(group.decision_rules, rules);
	assert.equal(
		exampleConfig(group),
		exampleConfig({ ...group, decision_rules: defaultDecisionRules }),
	);
	const email = await new InboxStore(db).insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Synthetic category A",
		body: "Choose category A.",
	});
	const [job] =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${email!.thread_id!}`;
	await processJob(db, "fake", job.token, transport);
	const jobs =
		await db`SELECT answer,status FROM conversation_classifications WHERE thread_id=${email!.thread_id!}`;
	assert.ok(jobs.every((j) => j.status === "complete"));
	assert.equal(jobs.filter((j) => j.answer).length, 1);
	const logs =
		await db`SELECT decision_rules,answer FROM classifier_provider_run_items WHERE job_token IN (SELECT token FROM conversation_classifications WHERE thread_id=${email!.thread_id!})`;
	assert.ok(
		logs.every(
			(j) =>
				JSON.stringify(j.decision_rules) ===
				JSON.stringify(logs[0].decision_rules),
		),
	);
	assert.deepEqual(logs[0].decision_rules, rules);
	assert.equal(logs.filter((j) => j.answer).length, 1);
	const draft = {
		name: group.name,
		selection: group.selection,
		instructions: group.instructions,
		enabled: group.enabled,
		tags: group.tags,
	};
	const run = async (decision_rules: typeof rules) =>
		await (
			await call("/classification/test", "POST", {
				mailbox_id: mailbox,
				thread_id: email!.thread_id,
				group: { ...draft, decision_rules },
				questions: [{ name: "Rules", question: "Pick category" }],
				execute: true,
			})
		).json();
	const strict = await run(defaultDecisionRules);
	assert.ok(
		strict.results.every(
			(r: { result: { answer: null } }) => r.result.answer === null,
		),
	);
	const relaxed = await run(rules);
	assert.equal(
		relaxed.results.filter(
			(r: { result: { answer: boolean } }) => r.result.answer,
		).length,
		1,
	);
	const q = groupChoice(group);
	assert.equal(
		interpretAnswer(
			q,
			{
				type: "choice",
				choice: "insufficient_evidence",
				confidence: 1,
				probabilities: {
					[group.tags[0].id]: 0,
					[group.tags[1].id]: 0,
					insufficient_evidence: 1,
				},
			},
			undefined,
			rules,
		).answer,
		null,
	);
});
test("standalone rules save, survive omitted updates and control draft tests", async () => {
	const [tag] =
		await db`INSERT INTO tags(name,color) VALUES('Rule standalone','#64748b') RETURNING id`;
	const body = {
		tag_id: tag.id,
		question: "Should this apply?",
		enabled: true,
		mailbox_ids: [],
		decision_rules: { ...defaultDecisionRules, yes: 0.65 },
	};
	const created = await (
		await call("/classification/classifiers", "POST", body)
	).json();
	assert.equal(created.decision_rules.yes, 0.65);
	const { decision_rules, ...without } = body;
	void decision_rules;
	const updated = await (
		await call("/classification/classifiers/" + created.id, "PUT", {
			...without,
			revision: created.revision,
		})
	).json();
	assert.equal(updated.decision_rules.yes, 0.65);
	const invalid = await call(
		"/classification/classifiers/" + created.id,
		"PUT",
		{
			...body,
			revision: updated.revision,
			decision_rules: { yes: 0.1, no: 0.9 },
		},
	);
	assert.equal(invalid.status, 400);
	const email = await new InboxStore(db).insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Synthetic standalone",
		body: "Please help.",
	});
	const response = await call("/classification/test", "POST", {
		mailbox_id: mailbox,
		thread_id: email!.thread_id,
		questions: [
			{
				name: "Standalone",
				question: body.question,
				decision_rules: body.decision_rules,
			},
		],
		execute: true,
	});
	assert.equal(response.status, 200);
	assert.equal((await response.json()).results[0].result.answer, true);
});
