import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MockLanguageModelV3 } from "ai/test";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import { DEFAULT_AGENT_MODEL, AGENT_MODELS } from "../shared/agent";
const schema = `test_compose_${randomUUID().replaceAll("-", "")}`;
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
let captured = "";
let modelId = "";
const model = new MockLanguageModelV3({
	doGenerate: async (options) => {
		captured = JSON.stringify(options.prompt);
		return {
			content: [
				{ type: "text", text: "Hello,\n\nThank you for your request." },
			],
			finishReason: { unified: "stop", raw: "stop" },
			usage: {
				inputTokens: { total: 2, noCache: 2, cacheRead: 0, cacheWrite: 0 },
				outputTokens: { total: 3, text: 3, reasoning: 0 },
			},
			warnings: [],
		};
	},
});
const api = createApi(db, {
	readAttachment: async () => null,
	agent: {
		model: (id) => {
			modelId = id;
			return model;
		},
		sources: ["workers"],
	},
});
const mailbox = "compose@example.test";
const other = "other@example.test";
const request = (body: unknown, target = mailbox) =>
	api.request(`http://localhost/api/v1/mailboxes/${target}/agent/compose`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Compose");
	await store.createMailbox(other, "Other");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
test("SDK draft generation uses mailbox settings and scoped conversation without saving or sending", async () => {
	const email = await store.insert(mailbox, {
		sender: "person@example.test",
		recipient: mailbox,
		subject: "Account",
		body: "Original request",
	});
	assert.ok(email);
	await store.insert(mailbox, {
		sender: "person@example.test",
		recipient: mailbox,
		subject: "Follow-up",
		body: "Please reply in French",
		thread_id: email.thread_id ?? undefined,
	});
	await store.insert(other, {
		sender: "other@example.test",
		recipient: other,
		subject: "Private",
		body: "OTHER MAILBOX SECRET",
	});
	await db`INSERT INTO agent_settings(mailbox_id,model,system_prompt) VALUES(${mailbox},${DEFAULT_AGENT_MODEL},'Use a warm tone')`;
	const [beforeCount] =
		await db`SELECT count(*)::int AS n FROM emails WHERE mailbox_id=${mailbox}`;
	const response = await request({
		emailId: email.id,
		instructions: "Explain the next steps",
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		text: "Hello,\n\nThank you for your request.",
		model: DEFAULT_AGENT_MODEL,
	});
	assert.equal(modelId, DEFAULT_AGENT_MODEL);
	assert.ok(captured.includes("Use a warm tone"));
	assert.ok(captured.includes("Original request"));
	assert.ok(captured.includes("Please reply in French"));
	assert.ok(!captured.includes("OTHER MAILBOX SECRET"));
	const [afterCount] =
		await db`SELECT count(*)::int AS n FROM emails WHERE mailbox_id=${mailbox}`;
	assert.equal(afterCount.n, beforeCount.n);
	assert.equal((await request({ emailId: email.id }, other)).status, 404);
});
test("new email requires instructions, rewrite requires text, invalid input is rejected", async () => {
	for (const body of [
		{},
		{ action: "shorten" },
		{ instructions: "x", action: "send" },
		{ instructions: "x", emailId: "invalid" },
		{ instructions: "x".repeat(2001) },
	])
		assert.equal((await request(body)).status, 400);
	assert.equal(
		(await request({ instructions: "Introduce our team", subject: "Hello" }))
			.status,
		200,
	);
	assert.equal(
		(await request({ action: "shorten", body: "A long draft" })).status,
		200,
	);
	assert.ok(captured.includes("A long draft"));
});
test("unconfigured and failed providers report errors without writing drafts", async () => {
	const unconfigured = createApi(db, { readAttachment: async () => null });
	const response = await unconfigured.request(
		`http://localhost/api/v1/mailboxes/${mailbox}/agent/compose`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ instructions: "Say hello" }),
		},
	);
	assert.equal(response.status, 503);
	const failed = createApi(db, {
		readAttachment: async () => null,
		agent: {
			model: () =>
				new MockLanguageModelV3({
					doGenerate: async () => {
						throw new Error("private provider internals");
					},
				}),
		},
	});
	const failure = await failed.request(
		`http://localhost/api/v1/mailboxes/${mailbox}/agent/compose`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ instructions: "Say hello" }),
		},
	);
	assert.equal(failure.status, 502);
	assert.ok(!(await failure.text()).includes("private provider internals"));
});

test("model override uses the shared catalog without changing mailbox defaults", async () => {
	const response = await request({
		instructions: "Say hello",
		model: AGENT_MODELS[1].id,
	});
	assert.equal(response.status, 200);
	assert.equal(modelId, AGENT_MODELS[1].id);
	assert.equal(
		(await request({ instructions: "Hello", model: "unknown/model" })).status,
		400,
	);
	const config = await api.request(
		`http://localhost/api/v1/mailboxes/${mailbox}/agent/compose`,
	);
	const data = await config.json();
	assert.equal(data.settings.model, DEFAULT_AGENT_MODEL);
	assert.ok(data.catalog.models.length > 0);
});
