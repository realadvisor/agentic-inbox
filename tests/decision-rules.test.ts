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
	const [job] =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${email!.thread_id!} AND classifier_id=${created.id}`;
	await processJob(db, "fake", job.token, transport);
	const raised = await call(
		"/classification/classifiers/" + created.id,
		"PUT",
		{
			...body,
			revision: updated.revision,
			decision_rules: { ...defaultDecisionRules, yes: 0.95 },
		},
	);
	assert.equal(raised.status, 200);
	const [preserved] =
		await db`SELECT status,token FROM conversation_classifications WHERE thread_id=${email!.thread_id!} AND classifier_id=${created.id}`;
	assert.equal(preserved.status, "complete");
	assert.equal(preserved.token, job.token);
});

test("saved rules resolve pending group reviews without Jev and preserve protected decisions", async () => {
	const draft = {
		name: "Reapply group",
		selection: "single",
		instructions: "Choose a category.",
		enabled: true,
		decision_rules: { ...defaultDecisionRules, probability: 0.99 },
		tags: ["Reapply A", "Reapply B"].map((name) => ({
			id: crypto.randomUUID(),
			name,
			color: "#64748b",
			description: "Category",
		})),
	};
	const group = await (await call("/tag-groups", "POST", draft)).json();
	const definitions =
		await db`SELECT c.* FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.group_id=${group.id}`;
	const ids = definitions.map((d) => d.id);
	const threads: string[] = [];
	for (let i = 0; i < 6; i++) {
		const email = await new InboxStore(db).insert(mailbox, {
			sender: "example@example.test",
			recipient: mailbox,
			subject: "Rules sample " + i,
			body: "Category A",
		});
		threads.push(email!.thread_id!);
		const [j] =
			await db`SELECT token FROM conversation_classifications WHERE thread_id=${email!.thread_id!} AND classifier_id IN ${db(ids)} LIMIT 1`;
		await processJob(db, "fake", j.token, transport);
	}
	await db`UPDATE conversation_classifications SET source='human' WHERE thread_id=${threads[1]} AND classifier_id IN ${db(ids)}`;
	await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor) VALUES(${mailbox},${threads[2]},${draft.tags[0].id},'manual','tester') ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET source='manual'`;
	await db`UPDATE conversations SET generation=generation+1 WHERE mailbox_id=${mailbox} AND thread_id=${threads[3]}`;
	await db`UPDATE conversation_classifications SET error='provider_context_limit' WHERE thread_id=${threads[4]} AND classifier_id IN ${db(ids)}`;
	const abstained =
		await db`SELECT r.id,r.response_body,i.question_key FROM classifier_provider_runs r JOIN classifier_provider_run_items i ON i.run_id=r.id WHERE r.thread_id=${threads[5]} AND i.classifier_id=${ids[0]} LIMIT 1`;
	const raw = JSON.parse(abstained[0].response_body);
	const answer = raw.answers[abstained[0].question_key];
	answer.choice = "insufficient_evidence";
	answer.confidence = 0.99;
	answer.probabilities = Object.fromEntries(
		Object.keys(answer.probabilities).map((key) => [
			key,
			key === "insufficient_evidence" ? 1 : 0,
		]),
	);
	await db`UPDATE classifier_provider_runs SET response_body=${JSON.stringify(raw)} WHERE id=${abstained[0].id}`;
	const response = await call("/tag-groups/" + group.id, "PUT", {
		...draft,
		revision: group.revision,
		decision_rules: {
			...defaultDecisionRules,
			probability: 0.6,
			confidence: 0.6,
			margin: 0.1,
		},
	});
	assert.equal(response.status, 200);
	const preserved =
		await db`SELECT revision,status FROM conversation_classifications WHERE thread_id=${threads[0]} AND classifier_id IN ${db(ids)}`;
	assert.equal(preserved.length, 2);
	assert.ok(
		preserved.every(
			(j) => j.status === "review" && j.revision === definitions[0].revision,
		),
	);
	const request = { classifier_ids: ids };
	const previewResponse = await call(
		"/classification/reapply-rules",
		"POST",
		request,
	);
	assert.equal(previewResponse.status, 200);
	const preview = await previewResponse.json();
	assert.equal(preview.resolved, 1);
	assert.equal(preview.remaining, 5);
	assert.equal(
		(
			await db`SELECT status FROM conversation_classifications WHERE thread_id=${threads[0]} AND classifier_id IN ${db(ids)}`
		)[0].status,
		"review",
	);
	const [count] =
		await db`SELECT count(*)::int AS n FROM classifier_provider_runs`;
	const applied = await call("/classification/reapply-rules", "POST", {
		...request,
		apply: true,
		fingerprint: preview.fingerprint,
		before: preview.before,
	});
	assert.equal(applied.status, 200);
	assert.equal((await applied.json()).resolved, 1);
	assert.equal(
		(await db`SELECT count(*)::int AS n FROM classifier_provider_runs`)[0].n,
		count.n,
	);
	const jobs =
		await db`SELECT status,answer,source FROM conversation_classifications WHERE thread_id=${threads[0]} AND classifier_id IN ${db(ids)}`;
	assert.ok(jobs.every((j) => j.status === "complete" && j.source === "jev"));
	assert.equal(jobs.filter((j) => j.answer).length, 1);
	assert.equal(
		(
			await db`SELECT count(*)::int AS n FROM conversation_tags WHERE thread_id=${threads[0]} AND tag_id IN ${db(draft.tags.map((t) => t.id))} AND removed_at IS NULL`
		)[0].n,
		1,
	);
	assert.equal(
		(
			await call("/classification/reapply-rules", "POST", {
				classifier_ids: [ids[0]],
			})
		).status,
		400,
	);
	await db`UPDATE classifiers SET decision_rules='{}' WHERE id IN ${db(ids)}`;
	assert.equal(
		(
			await call("/classification/reapply-rules", "POST", {
				...request,
				apply: true,
				fingerprint: preview.fingerprint,
				before: preview.before,
			})
		).status,
		409,
	);
});
