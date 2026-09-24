import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
	const api = createApi(db, { readAttachment: async () => null });
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
	assert.match(await response.text(), /Hello from the selected model/);
	await Promise.all(tasks);
	assert.equal(tasks.length, 1);
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
