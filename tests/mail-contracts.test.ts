import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import {
	mailListResponseSchema,
	messageDetailSchema,
	draftDetailSchema,
	saveDraftSchema,
	saveDraftResultSchema,
	sendEmailSchema,
	sendResultSchema,
} from "../shared/mail";
const schema = `test_contracts_${randomUUID().replaceAll("-", "")}`;
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const mailbox = "contracts@example.test";
const api = createApi(db, { readAttachment: async () => null });
const base = `/api/v1/mailboxes/${mailbox}`;
async function json(path: string, body?: unknown) {
	const response = await api.request(`http://localhost${base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	assert.ok(
		response.ok,
		`${response.status}: ${await response.clone().text()}`,
	);
	return response.json();
}
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(mailbox, "Contracts");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("actual list/search envelopes distinguish summary, full lists and details", async () => {
	const message = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "contract needle",
		body: "<p>body</p>",
	});
	assert.ok(message);
	for (const path of ["/emails", "/search?query=needle"]) {
		for (const view of ["", "summary"]) {
			const payload = await json(
				`${path}${path.includes("?") ? "&" : "?"}view=${view}`,
			);
			mailListResponseSchema.parse(payload);
			assert.equal(Array.isArray(payload), false);
			assert.equal("body" in payload.emails[0], view !== "summary");
			assert.equal("raw_headers" in payload.emails[0], view !== "summary");
			assert.equal("attachments" in payload.emails[0], false);
			assert.equal("draft_version" in payload.emails[0], false);
		}
	}
	const detail = messageDetailSchema.parse(await json(`/emails/${message.id}`));
	assert.equal(detail.body, "<p>body</p>");
	assert.equal(detail.draft_version, null);
	assert.deepEqual(detail.attachments, []);
	const thread = await json(`/threads/${message.thread_id}`);
	thread.forEach((entry: unknown) => messageDetailSchema.parse(entry));
	const empty = await json("/search?query=absent_unique_phrase&view=summary");
	assert.deepEqual(mailListResponseSchema.parse(empty), {
		emails: [],
		totalCount: 0,
	});
});

test("draft create/update/detail and every synthetic send route satisfy shared contracts", async () => {
	const source = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "source",
		body: "source",
		message_id: "<rfc-source@example.test>",
	});
	assert.ok(source);
	for (const mode of ["new", "reply", "reply-all", "forward"] as const) {
		const saved = saveDraftResultSchema.parse(
			await json("/drafts", {
				body: "draft",
				to: "recipient@example.test",
				draft_mode: mode,
				...(mode === "new" ? {} : { draft_source_id: source.id }),
			}),
		);
		const draft = draftDetailSchema.parse(
			await json(`/emails/${saved.draft_id}`),
		);
		assert.equal(draft.draft_mode, mode);
		assert.equal(draft.in_reply_to, null);
		assert.equal(draft.draft_source_id, mode === "new" ? null : source.id);
		const updated = saveDraftResultSchema.parse(
			await json("/drafts", {
				body: "edited",
				to: "recipient@example.test",
				draft_id: saved.draft_id,
				draft_version: saved.draft_version,
				draft_mode: mode,
			}),
		);
		assert.notEqual(updated.draft_version, saved.draft_version);
		const suffix =
			mode === "new"
				? ""
				: `/${source.id}/${mode === "forward" ? "forward" : "reply"}`;
		const result = sendResultSchema.parse(
			await json(`/emails${suffix}`, {
				to: "recipient@example.test",
				text: "sent",
				draft_id: saved.draft_id,
				draft_mode: mode,
			}),
		);
		assert.equal(result.status, "simulated");
		assert.ok(result.id);
		const delivered = messageDetailSchema.parse(
			await json(`/emails/${result.id}`),
		);
		assert.equal(
			delivered.in_reply_to,
			mode.startsWith("reply") ? "<rfc-source@example.test>" : null,
		);
	}
	const legacy = saveDraftResultSchema.parse(
		await json("/drafts", { body: "legacy", in_reply_to: source.id }),
	);
	assert.equal(
		draftDetailSchema.parse(await json(`/emails/${legacy.draft_id}`))
			.draft_mode,
		null,
	);
});

test("request defaults, legacy aliases and uncertain-send distinctions remain compatible", () => {
	const source = randomUUID();
	assert.equal(
		saveDraftSchema.parse({ body: "", in_reply_to: source }).draft_mode,
		undefined,
	);
	assert.equal(saveDraftSchema.parse({ body: "" }).to, "");
	assert.equal(
		sendEmailSchema.parse({ to: ["recipient@example.test"], text: "body" })
			.subject,
		"",
	);
	assert.equal(
		sendEmailSchema.safeParse({ to: "recipient@example.test" }).success,
		false,
	);
	for (const status of ["unknown", "sending", "failed", "accepted"]) {
		assert.equal(
			sendResultSchema.safeParse({
				id: source,
				sender: mailbox,
				sender_identity_id: mailbox,
				status,
			}).success,
			false,
		);
	}
	assert.equal(
		sendResultSchema.safeParse({
			status: "sent",
			sender: mailbox,
			sender_identity_id: mailbox,
		}).success,
		false,
	);
	assert.equal(
		sendResultSchema.safeParse({
			status: "sent",
			id: source,
			sender: mailbox,
			sender_identity_id: null,
		}).success,
		true,
	);
	assert.equal(
		sendResultSchema.safeParse({ error: "Previous send is unknown" }).success,
		false,
	);
});
