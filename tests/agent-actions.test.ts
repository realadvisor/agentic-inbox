import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { recipientList, carbonCopyList } from "../server/agent/action-tools";
import { randomUUID } from "node:crypto";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import { claimRun, createTools, stopRun } from "../server/agent/service";
import { getThreadWorkflow } from "../server/thread-status";
import { draftVersionSchema } from "../server/email-actions";

const schema = `test_actions_${randomUUID().replaceAll("-", "")}`;
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const mailbox = "actions@example.test",
	other = "other-actions@example.test";
const options = { toolCallId: "actions", messages: [] };
const api = createApi(db, { readAttachment: async () => null });
const incoming = (box = mailbox) =>
	store.insert(box, {
		sender: "sender@example.test",
		recipient: box,
		subject: "Help",
		body: "Hello",
	});
async function request(path: string, body: unknown, method = "POST") {
	return api.request(`http://localhost/api/v1/mailboxes/${mailbox}/${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}
async function active() {
	const run = {
		id: randomUUID(),
		mailbox,
		actor: "operator@example.test",
		prompt: "Organize this conversation",
	};
	await claimRun(db, run);
	const tools = createTools(db, run, () => {});
	assert.ok("set_thread_tag" in tools);
	return { run, tools };
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Actions");
	await store.createMailbox(other, "Other");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("agent actions share tag group overrides, status revisions and mailbox boundaries", async () => {
	const email = (await incoming())!,
		foreign = (await incoming(other))!;
	const [group] =
		await db`INSERT INTO tag_groups(name,selection,instructions) VALUES('Actions priority','single','Choose one') RETURNING id`;
	const [low, high] =
		await db`INSERT INTO tags(name,color,group_id,position) VALUES('Action low','#111111',${group.id},0),('Action high','#222222',${group.id},1) RETURNING id`;
	const { run, tools } = await active();
	try {
		for (const tag of [low, high])
			await tools.set_thread_tag.execute!(
				{ threadId: email.thread_id!, tagId: tag.id, action: "add" },
				options,
			);
		const tags = await store.tagsForThreads(mailbox, [email.thread_id!]);
		assert.deepEqual(
			tags.map((t) => t.id),
			[high.id],
		);
		assert.equal(tags[0].source, "manual");
		assert.equal(tags[0].actor, "Agent on behalf of operator@example.test");
		await tools.set_thread_tag.execute!(
			{ threadId: email.thread_id!, tagId: high.id, action: "remove" },
			options,
		);
		const [override] =
			await db`SELECT source,removed_at FROM conversation_tags WHERE mailbox_id=${mailbox} AND thread_id=${email.thread_id!} AND tag_id=${high.id}`;
		assert.equal(override.source, "manual");
		assert.ok(override.removed_at);
		const workflow = await getThreadWorkflow(db, mailbox, email.thread_id!);
		await tools.set_thread_status.execute!(
			{
				threadId: email.thread_id!,
				status: "done",
				revision: workflow.revision,
			},
			options,
		);
		await assert.rejects(
			async () =>
				tools.set_thread_status.execute!(
					{
						threadId: email.thread_id!,
						status: "open",
						revision: workflow.revision,
					},
					options,
				),
			/Conversation changed/,
		);
		const status = await getThreadWorkflow(db, mailbox, email.thread_id!);
		assert.equal(
			status.activity[0].actor,
			"Agent on behalf of operator@example.test",
		);
		await assert.rejects(
			async () =>
				tools.set_thread_tag.execute!(
					{ threadId: foreign.thread_id!, tagId: low.id, action: "add" },
					options,
				),
			/not found/,
		);
		const [turn] = await db`SELECT actions FROM agent_turns WHERE id=${run.id}`;
		assert.equal(
			turn.actions.length,
			4,
			"failed changes are not recorded as success",
		);
	} finally {
		await stopRun(db, mailbox, run.id);
	}
});

test("thread read state and email stars use the same API and agent behavior", async () => {
	const email = (await incoming())!,
		foreign = (await incoming(other))!;
	const { run, tools } = await active();
	try {
		await tools.set_thread_read.execute!(
			{ threadId: email.thread_id!, read: true },
			options,
		);
		assert.equal((await store.message(mailbox, email.id)).read, true);
		assert.equal(
			(await request(`threads/${email.thread_id}/read`, { read: false }))
				.status,
			204,
		);
		assert.equal((await store.message(mailbox, email.id)).read, false);
		await tools.set_email_starred.execute!(
			{ emailId: email.id, starred: true },
			options,
		);
		assert.equal((await store.message(mailbox, email.id)).starred, true);
		assert.equal(
			(await request(`emails/${email.id}`, { starred: false }, "PUT")).status,
			200,
		);
		assert.equal((await store.message(mailbox, email.id)).starred, false);
		await assert.rejects(
			async () =>
				tools.set_thread_read.execute!(
					{ threadId: foreign.thread_id!, read: true },
					options,
				),
			/not found/,
		);
		await assert.rejects(
			async () =>
				tools.set_email_starred.execute!(
					{ emailId: foreign.id, starred: true },
					options,
				),
			/not found/,
		);
		await stopRun(db, mailbox, run.id);
		await assert.rejects(
			async () =>
				tools.set_email_starred.execute!(
					{ emailId: email.id, starred: true },
					options,
				),
			/no longer active/,
		);
	} finally {
		await stopRun(db, mailbox, run.id);
	}
});

test("draft edits reject stale content, retain CC/BCC, and cannot edit foreign or sent messages", async () => {
	const created = await request("drafts", {
		to: "a@example.test",
		cc: "copy@example.test",
		body: "Original",
	});
	assert.equal(created.status, 201);
	const draft = await created.json();
	assert.ok(draftVersionSchema.safeParse(draft.draft_version).success);
	const { run, tools } = await active();
	try {
		const read = await tools.get_draft.execute!(
			{ draftId: draft.draft_id },
			options,
		);
		assert.ok("draft_version" in read);
		assert.equal(read.draft_version, draft.draft_version);
		const content = {
			draftId: draft.draft_id,
			draftVersion: draft.draft_version,
			to: "a@example.test",
			cc: "copy@example.test",
			bcc: "hidden@example.test",
			subject: "Updated",
			body: "<safe>",
		};
		await tools.update_draft.execute!(content, options);
		const saved = await store.message(mailbox, draft.draft_id);
		assert.equal(saved.body, "&lt;safe&gt;");
		assert.equal(saved.bcc, "hidden@example.test");
		assert.notEqual(saved.draft_version, draft.draft_version);
		await assert.rejects(
			async () =>
				tools.update_draft.execute!(
					{ ...content, body: "Stale agent" },
					options,
				),
			/Draft changed/,
		);
		const conflict = await request("drafts", {
			draft_id: draft.draft_id,
			draft_version: draft.draft_version,
			body: "Stale UI",
		});
		assert.equal(conflict.status, 409);
		const updated = await request("drafts", {
			draft_id: draft.draft_id,
			draft_version: saved.draft_version,
			body: "Human edit",
		});
		assert.equal(updated.status, 200);
		await assert.rejects(
			async () =>
				tools.update_draft.execute!(
					{ ...content, draftVersion: saved.draft_version! },
					options,
				),
			/Draft changed/,
		);
		assert.equal(
			(await store.message(mailbox, draft.draft_id)).body,
			"Human edit",
		);
		const foreign = (await store.insert(other, {
			sender: other,
			recipient: "a@example.test",
			subject: "Foreign",
			body: "Keep",
			folder_id: "draft",
			delivery_status: "draft",
		}))!;
		await assert.rejects(
			async () => tools.get_draft.execute!({ draftId: foreign.id }, options),
			/Not found/,
		);
		await assert.rejects(
			async () =>
				tools.update_draft.execute!(
					{ ...content, draftId: foreign.id },
					options,
				),
			/Draft not found/,
		);
		const latest = await store.message(mailbox, draft.draft_id);
		const patch = {
			draftId: draft.draft_id,
			draftVersion: latest.draft_version!,
			subject: "Subject only",
		};
		const parsedPatch = (tools.update_draft.inputSchema as z.ZodType).parse(
			patch,
		);
		assert.deepEqual(
			parsedPatch,
			patch,
			"omitted recipients and body do not acquire defaults",
		);
		await tools.update_draft.execute!(
			{
				draftId: draft.draft_id,
				draftVersion: latest.draft_version!,
				subject: "Subject only",
			},
			options,
		);
		const partial = await store.message(mailbox, draft.draft_id);
		assert.equal(partial.body, latest.body);
		assert.equal(partial.recipient, latest.recipient);
		assert.equal(partial.cc, latest.cc);
		assert.equal(partial.bcc, latest.bcc);
		const received = (await incoming())!;
		await assert.rejects(
			async () =>
				tools.update_draft.execute!(
					{ ...content, draftId: received.id },
					options,
				),
			/Draft not found/,
		);
	} finally {
		await stopRun(db, mailbox, run.id);
	}
});

test("automatic runs retain the narrow read/read/reply allowlist", () => {
	const tools = createTools(
		db,
		{
			id: randomUUID(),
			mailbox,
			actor: "automatic",
			prompt: "Draft",
			automatic: true,
			emailId: randomUUID(),
		},
		() => {},
	);
	assert.deepEqual(Object.keys(tools).sort(), [
		"draft_reply",
		"get_email",
		"get_thread",
	]);
});

test("new draft supports multiple To recipients and Cc/Bcc without sending", async () => {
	const { run, tools } = await active();
	try {
		const to = recipientList.parse(["one@example.test", "two@example.test"]);
		const cc = carbonCopyList.parse(["copy@example.test"]);
		const bcc = carbonCopyList.parse(["blind@example.test"]);
		const result = (await tools.draft_email.execute!(
			{ to, cc, bcc, subject: "Recipients", body: "Hello" },
			options,
		)) as { draft_id: string };
		const saved = await store.message(mailbox, result.draft_id);
		assert.equal(saved.recipient, "one@example.test, two@example.test");
		assert.equal(saved.cc, cc);
		assert.equal(saved.bcc, bcc);
		assert.equal(saved.delivery_status, "draft");
	} finally {
		await stopRun(db, mailbox, run.id);
	}
});

test("agent draft sender selection honors the API key mailbox scope", async () => {
	const run = {
		id: randomUUID(),
		mailbox,
		actor: "integration@example.test",
		prompt: "Draft a reply",
		permissions: ["mail:read", "drafts:manage"],
		mailboxIds: [mailbox],
	};
	await claimRun(db, run);
	const tools = createTools(db, run, () => {});
	assert.ok(
		"draft_email" in tools &&
			"list_senders" in tools &&
			"update_draft" in tools,
	);
	try {
		const config = await tools.list_senders.execute!({}, options);
		assert.ok(config && "senders" in config);
		assert.deepEqual(
			config.senders.map((s) => s.id),
			[mailbox],
		);
		await assert.rejects(
			async () =>
				tools.draft_email.execute!(
					{
						to: "customer@example.test",
						subject: "Wrong sender",
						body: "Hello",
						sender_identity_id: other,
					},
					options,
				),
			/does not permit/,
		);
		const result = await tools.draft_email.execute!(
			{
				to: "customer@example.test",
				subject: "Allowed sender",
				body: "Hello",
				sender_identity_id: mailbox,
			},
			options,
		);
		assert.ok(
			result &&
				typeof result === "object" &&
				"draft_id" in result &&
				typeof result.draft_id === "string",
		);
		const draft = await store.message(mailbox, result.draft_id);
		assert.equal(draft.sender_identity_id, mailbox);
		await assert.rejects(
			async () =>
				tools.update_draft.execute!(
					{
						draftId: draft.id,
						draftVersion: draft.draft_version!,
						sender_identity_id: other,
					},
					options,
				),
			/does not permit/,
		);
	} finally {
		await stopRun(db, mailbox, run.id);
	}
});
