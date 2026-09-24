import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	DefaultChatTransport,
	readUIMessageStream,
	isToolOrDynamicToolUIPart,
} from "ai";
import { turnsToMessages } from "../shared/agent-messages";
import type { InboxChatMessage, AgentTurn } from "../shared/agent";
import { MockLanguageModelV3 } from "ai/test";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import {
	claimRun,
	createTools,
	executeRun,
	saveSettings,
	getSettings,
	type Run,
} from "../server/agent/service";
import {
	consumeAgentJobs,
	publishAgentJobs,
	AGENT_QUEUE,
} from "../server/agent/queue";
import {
	getCatalog,
	parseGatewayCatalog,
	refreshCatalog,
} from "../server/agent/catalog";
import { agentProviders } from "../server/agent/providers";
import { AGENT_MODELS } from "../shared/agent";

const schema = `test_agent_${randomUUID().replaceAll("-", "")}`;
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const a = "agent@example.test",
	b = "other@example.test";
const toolOptions = { toolCallId: "test", messages: [] };
const run = (mailbox = a): Run => ({
	id: randomUUID(),
	mailbox,
	prompt: "Draft a reply",
	actor: "tester",
});
const finish = async (r: Run) => {
	await db`UPDATE agent_settings SET active_run=NULL,lease_until=NULL WHERE mailbox_id=${r.mailbox}`;
	await db`UPDATE agent_turns SET status='complete' WHERE id=${r.id}`;
};
const incoming = (mailbox = a) =>
	store.insert(mailbox, {
		sender: "person@example.test",
		recipient: mailbox,
		subject: "Help",
		body: "Please help",
	});
function textModel() {
	return new MockLanguageModelV3({
		doStream: async () => ({
			stream: new ReadableStream({
				start(controller) {
					controller.enqueue({ type: "text-start", id: "text" });
					controller.enqueue({
						type: "text-delta",
						id: "text",
						delta: "Hello from the selected model.",
					});
					controller.enqueue({ type: "text-end", id: "text" });
					controller.enqueue({
						type: "finish",
						finishReason: { unified: "stop", raw: "stop" },
						usage: {
							inputTokens: {
								total: 1,
								noCache: 1,
								cacheRead: 0,
								cacheWrite: 0,
							},
							outputTokens: { total: 1, text: 1, reasoning: 0 },
						},
					});
					controller.close();
				},
			}),
		}),
	});
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(a, "Agent");
	await store.createMailbox(b, "Other");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("model settings persist per mailbox; invalid providers are rejected", async () => {
	const api = createApi(db, {
		readAttachment: async () => null,
		agent: { model: () => textModel() },
	});
	const path = `http://127.0.0.1:4311/api/v1/mailboxes/${a}/agent/settings`;
	const settings = {
		model: AGENT_MODELS[1].id,
		auto_draft: false,
		system_prompt: "Write in French",
	};
	assert.equal(
		(
			await api.request(path, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(settings),
			})
		).status,
		200,
	);
	assert.deepEqual(await getSettings(db, a), settings);
	assert.equal((await getSettings(db, b)).model, AGENT_MODELS[0].id);
	assert.equal(
		(
			await api.request(path, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...settings, model: "openai/gpt" }),
			})
		).status,
		400,
	);
	assert.equal(
		(
			await api.request(path, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ...settings, auto_draft: true }),
			})
		).status,
		503,
	);
	assert.equal(
		(
			await api.request(path.replace(a, "missing@example.test"), {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(settings),
			})
		).status,
		404,
	);
});

test("tools cannot read or mutate another mailbox, send, or delete received mail", async () => {
	const foreign = (await incoming(b))!;
	const r = run();
	await claimRun(db, r);
	try {
		const tools = createTools(db, r, () => {});
		assert.ok("discard_draft" in tools && "mark_email_read" in tools);
		assert.equal("send_email" in tools, false);
		assert.equal("delete_email" in tools, false);
		await assert.rejects(async () =>
			tools.get_email.execute!({ emailId: foreign.id }, toolOptions),
		);
		await assert.rejects(async () =>
			tools.draft_reply.execute!(
				{ originalEmailId: foreign.id, body: "No leak" },
				toolOptions,
			),
		);
		await assert.rejects(async () =>
			tools.discard_draft!.execute!({ draftId: foreign.id }, toolOptions),
		);
		await assert.rejects(async () =>
			tools.mark_email_read!.execute!(
				{ emailId: foreign.id, read: true },
				toolOptions,
			),
		);
		assert.equal((await store.message(b, foreign.id)).read, false);
	} finally {
		await finish(r);
	}
});

test("reply drafts preserve the original thread and Reply-To; HTML is escaped and actions persist", async () => {
	const email = (await incoming())!;
	await db`UPDATE emails SET reply_to='reply@example.test' WHERE id=${email.id}`;
	const r = run();
	await claimRun(db, r);
	try {
		await createTools(db, r, () => {}).draft_reply.execute!(
			{ originalEmailId: email.id, body: '<script>alert("x")</script>\nHello' },
			toolOptions,
		);
		const [draft] =
			await db`SELECT * FROM emails WHERE mailbox_id=${a} AND thread_id=${email.thread_id!} AND delivery_status='draft'`;
		assert.equal(draft.in_reply_to, email.id);
		assert.equal(draft.recipient, "reply@example.test");
		assert.match(draft.body, /&lt;script&gt;/);
		assert.equal(draft.folder_id, "draft");
		const [turn] = await db`SELECT actions FROM agent_turns WHERE id=${r.id}`;
		assert.equal(turn.actions[0].tool, "draft_reply");
		assert.equal(JSON.parse(turn.actions[0].result).draft_id, draft.id);
	} finally {
		await finish(r);
	}
});

test("concurrent and duplicate runs are rejected and expired runs cannot mutate", async () => {
	const r = run();
	await claimRun(db, r);
	await assert.rejects(() => claimRun(db, run()), /already working/);
	await assert.rejects(() => claimRun(db, r), /already started/);
	await db`UPDATE agent_settings SET lease_until=now()-interval '1 second' WHERE mailbox_id=${a}`;
	const tools = createTools(db, r, () => {});
	assert.ok("draft_email" in tools);
	await assert.rejects(
		async () =>
			tools.draft_email.execute!(
				{ to: "person@example.test", subject: "Expired", body: "No" },
				toolOptions,
			),
		/no longer active/,
	);
	await finish(r);
});

test("streamed chat uses the saved model, persists history, and keeps DB work registered", async () => {
	const chosen: string[] = [],
		tasks: Promise<unknown>[] = [];
	const api = createApi(db, {
		readAttachment: async () => null,
		agent: {
			model: (id) => {
				chosen.push(id);
				return textModel();
			},
			waitUntil: (task) => tasks.push(task),
		},
	});
	const r = run();
	const response = await api.request(
		`http://127.0.0.1:4311/api/v1/mailboxes/${a}/agent/chat`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: r.id, prompt: "Say hello" }),
		},
	);
	assert.equal(response.status, 200);
	assert.match(
		response.headers.get("content-type") ?? "",
		/text\/event-stream/,
	);
	assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");
	assert.match(await response.text(), /Hello from the selected model/);
	await Promise.all(tasks);
	assert.equal(tasks.length, 2);
	assert.deepEqual(chosen, [AGENT_MODELS[1].id]);
	const [turn] = await db`SELECT * FROM agent_turns WHERE id=${r.id}`;
	assert.equal(turn.status, "complete");
	assert.match(turn.answer, /Hello/);
});

test("provider failure is recorded and releases the mailbox lease", async () => {
	const r = run();
	const settings = await claimRun(db, r);
	const ok = await executeRun(
		db,
		r,
		settings,
		() =>
			new MockLanguageModelV3({
				doStream: async () => {
					throw new Error("provider unavailable");
				},
			}),
	);
	assert.equal(ok, false);
	const [turn] = await db`SELECT status FROM agent_turns WHERE id=${r.id}`;
	assert.equal(turn.status, "failed");
	const [lease] =
		await db`SELECT active_run FROM agent_settings WHERE mailbox_id=${a}`;
	assert.equal(lease.active_run, null);
});

test("auto-draft jobs are opt-in and duplicated queue deliveries do not rerun the model", async () => {
	const disabled = (await incoming(b))!;
	assert.equal(
		(await db`SELECT id FROM agent_jobs WHERE email_id=${disabled.id}`).length,
		0,
	);
	await saveSettings(db, b, {
		model: AGENT_MODELS[2].id,
		system_prompt: "",
		auto_draft: true,
	});
	const email = (await incoming(b))!;
	const [job] = await db`SELECT * FROM agent_jobs WHERE email_id=${email.id}`;
	assert.ok(job);
	let sent = 0;
	await publishAgentJobs(db, {
		sendBatch: async (messages) => {
			sent += messages.length;
		},
	});
	assert.equal(sent, 1);
	let calls = 0,
		acks = 0;
	const batch = {
		queue: AGENT_QUEUE,
		messages: [
			{
				body: { version: 1, token: job.id },
				ack: () => {
					acks++;
				},
				retry: () => assert.fail("Unexpected retry"),
			},
		],
	};
	const factory = (id: string) => {
		assert.equal(id, AGENT_MODELS[2].id);
		calls++;
		return textModel();
	};
	await consumeAgentJobs(db, batch, factory);
	await consumeAgentJobs(db, batch, factory);
	assert.equal(calls, 1);
	assert.equal(acks, 2);
});

test("automatic tools cannot compose new mail or mutate folders and stale threads cannot get drafts", async () => {
	const email = (await incoming(b))!;
	const r = { ...run(b), automatic: true, emailId: email.id };
	await claimRun(db, r);
	try {
		const [conversation] =
			await db`SELECT generation FROM conversations WHERE mailbox_id=${b} AND thread_id=${email.thread_id!}`;
		const tools = createTools(db, r, () => {}, conversation.generation);
		assert.equal("draft_email" in tools, false);
		assert.equal("move_email" in tools, false);
		assert.equal("discard_draft" in tools, false);
		await store.insert(b, {
			sender: "person@example.test",
			recipient: b,
			subject: "Update",
			body: "Never mind",
			thread_id: email.thread_id!,
		});
		await assert.rejects(
			async () =>
				tools.draft_reply.execute!(
					{ originalEmailId: email.id, body: "Stale" },
					toolOptions,
				),
			/Conversation changed/,
		);
	} finally {
		await finish(r);
	}
});

test("disabling auto-drafts stops a run before it writes", async () => {
	const email = (await incoming(b))!;
	const r = { ...run(b), automatic: true, emailId: email.id };
	await claimRun(db, r);
	await saveSettings(db, b, {
		...(await getSettings(db, b)),
		auto_draft: false,
	});
	await assert.rejects(
		async () =>
			createTools(db, r, () => {}).draft_reply.execute!(
				{ originalEmailId: email.id, body: "No" },
				toolOptions,
			),
		/no longer active/,
	);
	await finish(r);
});

test("repeated model tool calls save only one draft per run", async () => {
	const email = (await incoming())!;
	const r = run();
	await claimRun(db, r);
	try {
		const tools = createTools(db, r, () => {});
		const results = await Promise.all(
			[1, 2].map(() =>
				tools.draft_reply.execute!(
					{ originalEmailId: email.id, body: "Hello" },
					toolOptions,
				),
			),
		);
		assert.deepEqual(results[0], results[1]);
		const [count] =
			await db`SELECT count(*)::int AS n FROM emails WHERE mailbox_id=${a} AND thread_id=${email.thread_id!} AND delivery_status='draft'`;
		assert.equal(count.n, 1);
		const [turn] = await db`SELECT actions FROM agent_turns WHERE id=${r.id}`;
		assert.equal(turn.actions.length, 1);
	} finally {
		await finish(r);
	}
});

const gatewayModels = {
	data: [
		{
			id: "anthropic/test-claude",
			name: "Test Claude",
			type: "language",
			tags: ["tool-use"],
			supported_specifications: ["v3"],
			context_window: 200000,
			pricing: { input: "0.000003", output: "0.000015" },
		},
		{
			id: "openai/test-gpt",
			name: "Test GPT",
			type: "language",
			supported_parameters: ["tools"],
		},
	],
};
test("catalog only imports compatible language models and converts published pricing", () => {
	const models = parseGatewayCatalog({
		data: [
			...gatewayModels.data,
			{ id: "openai/embedding", type: "embedding", tags: ["tool-use"] },
			{ id: "openai/no-tools", type: "language" },
			{
				id: "openai/future-spec",
				type: "language",
				tags: ["tool-use"],
				supported_specifications: ["v4"],
			},
			{ id: "@cf/zai-org/fake", type: "language", tags: ["tool-use"] },
			{ id: "https://malicious.test", type: "language", tags: ["tool-use"] },
			null,
		],
	});
	assert.deepEqual(
		models.map((m) => m.id),
		gatewayModels.data.map((m) => m.id),
	);
	assert.equal(models[0].input_price, 3);
	assert.equal(models[0].output_price, 15);
	assert.equal(models[1].input_price, null);
});

test("refresh persists catalog, retains defaults and Workers models, and preserves snapshot on failure", async () => {
	const mailbox = "catalog@example.test";
	await store.createMailbox(mailbox, "Catalog");
	await refreshCatalog(db, async () => gatewayModels);
	await saveSettings(db, mailbox, {
		model: "anthropic/test-claude",
		system_prompt: "Hello",
		auto_draft: false,
	});
	const before = await getCatalog(db, ["workers", "gateway"]);
	assert.ok(before.refreshed_at);
	assert.ok(before.models.find((m) => m.id === "openai/test-gpt")?.selectable);
	const disabled = await getCatalog(db, ["workers"]);
	assert.equal(
		disabled.models.find((m) => m.id === "openai/test-gpt")?.selectable,
		false,
	);
	for (const load of [
		async () => {
			throw new Error("offline");
		},
		async () => ({ data: [] }),
	]) {
		await assert.rejects(
			refreshCatalog(db, load),
			/existing model list and default were kept/,
		);
		assert.deepEqual(await getCatalog(db, ["workers", "gateway"]), before);
	}
	await refreshCatalog(db, async () => ({ data: [gatewayModels.data[1]] }));
	const after = await getCatalog(db, ["workers", "gateway"]);
	assert.equal(
		after.models.find((m) => m.id === "anthropic/test-claude")?.available,
		false,
	);
	assert.equal(
		after.models.filter((m) => m.source === "workers" && m.selectable).length,
		3,
	);
	assert.equal((await getSettings(db, mailbox)).model, "anthropic/test-claude");
	await assert.rejects(claimRun(db, run(mailbox)), /not available/);
	// A retired default must not prevent disabling automatic drafting.
	await db`UPDATE agent_settings SET auto_draft=true WHERE mailbox_id=${mailbox}`;
	await saveSettings(db, mailbox, {
		model: "anthropic/test-claude",
		system_prompt: "Hello",
		auto_draft: false,
	});
});

test("chat overrides support Anthropic and OpenAI without changing the default; automatic runs use default", async () => {
	const mailbox = "overrides@example.test";
	await store.createMailbox(mailbox, "Overrides");
	const chosen: string[] = [];
	const api = createApi(db, {
		readAttachment: async () => null,
		agent: {
			sources: ["workers", "gateway"],
			fetchCatalog: async () => gatewayModels,
			model: (id) => {
				chosen.push(id);
				return textModel();
			},
		},
	});
	const response = await api.request(
		"http://127.0.0.1:4311/api/v1/agent/models/refresh",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
		},
	);
	assert.equal(response.status, 200);
	assert.ok(
		(await response.json()).models.some(
			(m: { id: string }) => m.id === "anthropic/test-claude",
		),
	);
	for (const model of ["anthropic/test-claude", "openai/test-gpt"]) {
		const id = randomUUID();
		const response = await api.request(
			`http://127.0.0.1:4311/api/v1/mailboxes/${mailbox}/agent/chat`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id, model, prompt: "Hello" }),
			},
		);
		assert.equal(response.status, 200);
		assert.match(await response.text(), /Hello from the selected model/);
		const [turn] =
			await db`SELECT model,status FROM agent_turns WHERE id=${id}`;
		assert.equal(turn.model, model);
		assert.equal(turn.status, "complete");
		assert.equal((await getSettings(db, mailbox)).model, AGENT_MODELS[0].id);
	}
	assert.deepEqual(chosen, ["anthropic/test-claude", "openai/test-gpt"]);
	await saveSettings(db, mailbox, {
		model: "anthropic/test-claude",
		system_prompt: "",
		auto_draft: true,
	});
	const r = { ...run(mailbox), automatic: true, model: "openai/test-gpt" };
	assert.equal((await claimRun(db, r)).model, "anthropic/test-claude");
	await finish(r);
	const workersOnly = createApi(db, {
		readAttachment: async () => null,
		agent: { model: () => textModel() },
	});
	for (const path of ["settings", "chat"]) {
		const result = await workersOnly.request(
			`http://127.0.0.1:4311/api/v1/mailboxes/${mailbox}/agent/${path}`,
			{
				method: path === "settings" ? "PUT" : "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(
					path === "settings"
						? { model: "openai/test-gpt", system_prompt: "", auto_draft: false }
						: { id: randomUUID(), model: "openai/test-gpt", prompt: "Hello" },
				),
			},
		);
		assert.equal(result.status, 503);
	}
});

test("provider routing keeps Workers AI local to the binding and external providers on the gateway", () => {
	const empty = agentProviders();
	assert.equal(empty.model, undefined);
	assert.deepEqual(empty.sources, []);
	const gateway = agentProviders(undefined, "synthetic-test-key");
	assert.deepEqual(gateway.sources, ["gateway"]);
	for (const model of ["anthropic/test-claude", "openai/test-gpt"]) {
		const instance = gateway.model!(model);
		assert.ok(typeof instance !== "string");
		assert.equal(instance.modelId, model);
	}
	assert.throws(
		() => gateway.model!(AGENT_MODELS[0].id),
		/Workers AI is not configured/,
	);
});

test("native SDK transport persists structured tools and replays results in follow-up context", async () => {
	const mailbox = "sdk@example.test";
	await store.createMailbox(mailbox, "SDK");
	const email = (await incoming(mailbox))!;
	let calls = 0;
	const prompts: unknown[] = [];
	const tasks: Promise<unknown>[] = [];
	const model = new MockLanguageModelV3({
		doStream: async (options) => {
			prompts.push(options.prompt);
			if (calls++ > 0) return textModel().doStream(options);
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({
							type: "tool-call",
							toolCallId: "read.original:provider/1",
							toolName: "get_email",
							input: JSON.stringify({ emailId: email.id }),
						});
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "tool-calls", raw: "tool_calls" },
							usage: {
								inputTokens: {
									total: 1,
									noCache: 1,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 1, text: 1, reasoning: 0 },
							},
						});
						controller.close();
					},
				}),
			};
		},
	});
	const app = createApi(db, {
		readAttachment: async () => null,
		agent: { model: () => model, waitUntil: (task) => tasks.push(task) },
	});
	const transport = new DefaultChatTransport<InboxChatMessage>({
		api: `http://127.0.0.1:4311/api/v1/mailboxes/${mailbox}/agent/chat`,
		fetch: async (input, init) => app.request(String(input), init),
		prepareSendMessagesRequest: ({ messages }) => ({
			body: { id: messages[messages.length - 1].id, prompt: "Read my email" },
		}),
	});
	const id = randomUUID();
	const stream = await transport.sendMessages({
		trigger: "submit-message",
		chatId: mailbox,
		messageId: undefined,
		abortSignal: undefined,
		messages: [
			{ id, role: "user", parts: [{ type: "text", text: "Read my email" }] },
		],
	});
	let last: InboxChatMessage | undefined;
	for await (const message of readUIMessageStream<InboxChatMessage>({ stream }))
		last = message;
	await Promise.all(tasks);
	assert.equal(last?.id, `${id}-assistant`);
	assert.equal(last?.metadata?.model, AGENT_MODELS[0].id);
	assert.ok(
		last?.parts.some(
			(p) =>
				isToolOrDynamicToolUIPart(p) &&
				p.state === "output-available" &&
				JSON.stringify(p.output).includes(email.id),
		),
	);
	const [turn] = await db<
		AgentTurn[]
	>`SELECT * FROM agent_turns WHERE id=${id}`;
	assert.deepEqual(turn.ui_message, JSON.parse(JSON.stringify(last)));
	assert.deepEqual(
		turnsToMessages([turn])[1].parts,
		JSON.parse(JSON.stringify(last?.parts)),
	);
	const followup = await app.request(
		`http://127.0.0.1:4311/api/v1/mailboxes/${mailbox}/agent/chat`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				id: randomUUID(),
				prompt: "What did that email say?",
			}),
		},
	);
	await followup.text();
	await Promise.all(tasks);
	assert.match(JSON.stringify(prompts.at(-1)), new RegExp(email.id));
	assert.match(JSON.stringify(prompts.at(-1)), /Please help/);
	const replay = prompts.at(-1) as Array<{
		content: Array<{ type: string; toolCallId?: string }> | string;
	}>;
	const toolParts = replay
		.flatMap((m) => (typeof m.content === "string" ? [] : m.content))
		.filter((p) => p.type === "tool-call" || p.type === "tool-result");
	assert.equal(toolParts.length, 2);
	assert.match(toolParts[0].toolCallId!, /^[a-zA-Z0-9_-]+$/);
	assert.equal(toolParts[0].toolCallId, toolParts[1].toolCallId);
	assert.ok(
		JSON.stringify(turn.ui_message).includes("read.original:provider/1"),
	);
});

test("browser disconnect does not lose native UI history or leave the mailbox lease active", async () => {
	const mailbox = "disconnect@example.test";
	await store.createMailbox(mailbox, "Disconnect");
	const tasks: Promise<unknown>[] = [];
	const app = createApi(db, {
		readAttachment: async () => null,
		agent: { model: () => textModel(), waitUntil: (task) => tasks.push(task) },
	});
	const id = randomUUID();
	const response = await app.request(
		`http://127.0.0.1:4311/api/v1/mailboxes/${mailbox}/agent/chat`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, prompt: "Hello" }),
		},
	);
	await response.body!.cancel();
	await Promise.all(tasks);
	const [turn] =
		await db`SELECT status,ui_message FROM agent_turns WHERE id=${id}`;
	assert.equal(turn.status, "complete");
	assert.ok(
		turn.ui_message.parts.some((p: { type: string }) => p.type === "text"),
	);
	const [lease] =
		await db`SELECT active_run FROM agent_settings WHERE mailbox_id=${mailbox}`;
	assert.equal(lease.active_run, null);
});
