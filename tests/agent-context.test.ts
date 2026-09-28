import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createTools } from "../server/agent/service";
import { agentEmailQuerySchema } from "../server/agent/read-tools";
import { changeThreadStatus } from "../server/thread-status";
import { createApi } from "../server/api";

const schema = `test_agent_context_${randomUUID().replaceAll("-", "")}`;
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const mailbox = "context@example.test",
	other = "foreign@example.test";
const opts = { toolCallId: "context", messages: [] };
const run = { id: randomUUID(), mailbox, prompt: "Search", actor: "tester" };
const tools = (() => {
	const value = createTools(db, run, () => {});
	assert.ok("search_emails" in value);
	return value;
})();
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Context");
	await store.createMailbox(other, "Other");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
const incoming = (target = mailbox) =>
	store.insert(target, {
		sender: "alice@example.test",
		recipient: target,
		subject: "Context test",
		body: "Help",
	});

test("search filters and pagination reuse mailbox-scoped API results", async () => {
	const first = (await incoming())!;
	const second = (await incoming())!;
	await incoming(other);
	await db`UPDATE emails SET starred=true WHERE id IN ${db([first.id, second.id])}`;
	const input = agentEmailQuerySchema.parse({
		query: "Context test",
		is_starred: true,
		is_read: false,
		limit: 1,
	});
	const result = await tools.search_emails!.execute!(input, opts);
	assert.ok("emails" in result);
	assert.equal(result.totalCount, 2);
	assert.equal(result.has_more, true);
	const next = await tools.search_emails!.execute!({ ...input, page: 2 }, opts);
	assert.ok("emails" in next);
	assert.notEqual(result.emails[0].id, next.emails[0].id);
	assert.equal(next.has_more, false);
	assert.deepEqual(result.emails[0].tags, []);
	assert.equal(result.emails[0].thread_status, "open");
	assert.equal(result.emails[0].read, false);
	const api = createApi(db, { readAttachment: async () => null });
	const response = await api.request(
		`http://localhost/api/v1/mailboxes/${mailbox}/emails?query=Context%20test&is_starred=true&is_read=false&limit=1&page=1`,
	);
	const payload = await response.json();
	assert.equal(payload.emails[0].id, result.emails[0].id);
});

test("email and thread reads include workflow revision and activity, and reject other mailboxes", async () => {
	const email = (await incoming())!;
	await changeThreadStatus(
		db,
		mailbox,
		email.thread_id!,
		{ status: "done", revision: 1, reason: "Resolved" },
		"reviewer",
	);
	const result = await tools.get_email.execute!({ emailId: email.id }, opts);
	assert.ok("workflow" in result);
	assert.equal(result.workflow.status, "done");
	assert.equal(result.workflow.revision, 2);
	assert.equal(result.workflow.activity[0].reason, "Resolved");
	const thread = await tools.get_thread.execute!(
		{ threadId: email.thread_id! },
		opts,
	);
	assert.ok("workflow" in thread);
	assert.equal(thread.workflow.status, "done");
	assert.deepEqual(thread.tags, result.tags);
	assert.deepEqual(thread.scores, result.scores);
	const foreign = (await incoming(other))!;
	await assert.rejects(async () =>
		tools.get_email.execute!({ emailId: foreign.id }, opts),
	);
	await assert.rejects(async () =>
		tools.get_thread.execute!({ threadId: foreign.thread_id! }, opts),
	);
});

test("recipient lookup stays in mailbox and automatic drafting keeps only its original tools", async () => {
	await incoming();
	await store.insert(other, {
		sender: "alicia-private@example.test",
		recipient: other,
		subject: "Private",
		body: "Private",
	});
	const suggestions = await tools.search_recipients!.execute!(
		{ query: "ali" },
		opts,
	);
	assert.ok(Array.isArray(suggestions));
	assert.ok(suggestions.some((value) => value.email === "alice@example.test"));
	assert.ok(
		suggestions.every((value) => value.email !== "alicia-private@example.test"),
	);
	const email = (await incoming())!;
	const automatic = createTools(
		db,
		{ ...run, automatic: true, emailId: email.id },
		() => {},
	);
	assert.deepEqual(Object.keys(automatic).sort(), [
		"draft_reply",
		"get_email",
		"get_thread",
	]);
	const another = (await incoming())!;
	await assert.rejects(async () =>
		automatic.get_thread.execute!({ threadId: another.thread_id! }, opts),
	);
});

test("tag definitions agree with API and query validation rejects malformed bounds", async () => {
	const api = createApi(db, { readAttachment: async () => null });
	const response = await api.request("http://localhost/api/v1/tag-groups");
	const definitions = await tools.list_tag_groups!.execute!({ page: 1 }, opts);
	assert.ok("groups" in definitions);
	assert.deepEqual(
		JSON.parse(JSON.stringify(definitions.groups)),
		await response.json(),
	);
	assert.ok(
		definitions.standalone_tags.some((tag) => tag.name === "Needs reply"),
	);
	assert.equal(
		agentEmailQuerySchema.safeParse({ tag_ids: ["invalid"] }).success,
		false,
	);
	assert.equal(
		agentEmailQuerySchema.safeParse({ date_start: "yesterday" }).success,
		false,
	);
	assert.equal(agentEmailQuerySchema.safeParse({ limit: 1000 }).success, false);
});

test("score search exposes current confidence and review state with scale thresholds", async () => {
	const api = createApi(db, { readAttachment: async () => null });
	const tags = ["Low", "Medium", "High"].map((name, index) => ({
		id: randomUUID(),
		name,
		color: "#2563eb",
		description: `Impact level ${index}`,
	}));
	const response = await api.request("http://localhost/api/v1/tag-groups", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: "Context scale",
			selection: "score",
			instructions: "Assess impact",
			enabled: true,
			tags,
			decision_rules: { score_boundaries: [0.4, 1.6] },
		}),
	});
	assert.equal(response.status, 201);
	const group = await response.json();
	const email = (await incoming())!;
	await db`UPDATE conversation_classifications j SET status='review',score=1.7,confidence=.4,answer=NULL FROM classifiers c WHERE j.classifier_id=c.id AND c.tag_id IN ${db(tags.map((tag) => tag.id))} AND j.mailbox_id=${mailbox} AND j.thread_id=${email.thread_id!}`;
	const result = await tools.search_emails!.execute!(
		agentEmailQuerySchema.parse({ score_group: group.id, needs_review: true }),
		opts,
	);
	assert.ok("emails" in result);
	assert.equal(result.emails[0].id, email.id);
	assert.equal(result.emails[0].scores[0].score, 1.7);
	assert.equal(result.emails[0].scores[0].confidence, 0.4);
	assert.equal(result.emails[0].scores[0].needs_review, true);
	const definitions = await tools.list_tag_groups!.execute!({ page: 1 }, opts);
	assert.ok("groups" in definitions);
	const scale = definitions.groups.find((item) => item.id === group.id)!;
	assert.deepEqual(scale.boundaries, [0.4, 1.6]);
	assert.equal(scale.maximum, 2);
});
