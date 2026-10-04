import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import { sendReal, type MailSender } from "../server/outbound";
import { useUIStore } from "../app/hooks/useUIStore";

const schema = `draft_intent_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const box = "info@ingest.realadvisor.com";
const api = createApi(db, { readAttachment: async () => null });
const call = (path: string, body: unknown) =>
	api.request(`http://localhost/api/v1/mailboxes/${box}/${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await store.createMailbox(box, "Synthetic intent test");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
for (const mode of ["new", "reply", "reply-all", "forward"] as const) {
	test(`${mode}: save/update/reopen/direct send and retry after draft deletion preserve intent`, async () => {
		const parent = (await store.insert(box, {
			sender: "customer@example.test",
			recipient: "info@realadvisor.com",
			subject: "Source",
			body: "Source",
			message_id: `<${crypto.randomUUID()}@external.test>`,
			email_references: "<ancestor@external.test>",
		}))!;
		const input = {
			draft_mode: mode,
			draft_source_id: mode === "new" ? undefined : parent.id,
			to: "customer@example.test",
			subject: "Arbitrary subject",
			body: "<p>Draft</p>",
		};
		const saved = await call("drafts", input);
		assert.equal(saved.status, 201);
		const { draft_id, draft_version } = await saved.json();
		let draft = await store.message(box, draft_id);
		assert.equal(draft.draft_mode, mode);
		assert.equal(draft.in_reply_to, null);
		assert.equal(draft.draft_source_id, mode === "new" ? null : parent.id);
		const update = await call("drafts", {
			...input,
			draft_id,
			draft_version,
			body: "<p>Updated</p>",
		});
		assert.equal(update.status, 200);
		assert.equal(
			(await call("drafts", { ...input, draft_id, draft_version })).status,
			409,
		);
		draft = await store.message(box, draft_id);
		for (const open of [
			useUIStore.getState().startCompose,
			useUIStore.getState().openComposeModal,
		]) {
			open({ mode: "new", draftEmail: draft });
			assert.equal(useUIStore.getState().composeOptions.mode, mode);
			assert.ok(useUIStore.getState().composeOptions.sendScope);
		}
		const email = {
			draft_id,
			to: "customer@example.test",
			subject: draft.subject,
			html: draft.body!,
		};
		const simulated = await call("emails", email);
		assert.equal(simulated.status, 201);
		const sent = await store.message(box, (await simulated.json()).id);
		const reply = mode === "reply" || mode === "reply-all";
		assert.equal(sent.in_reply_to, reply ? parent.message_id : null);
		assert.equal(sent.thread_id === parent.thread_id, reply);
		const calls: Parameters<MailSender["send"]>[0][] = [];
		const sender: MailSender = {
			send: async (mail) => {
				calls.push(mail);
				return { messageId: `<${crypto.randomUUID()}@test.invalid>` };
			},
		};
		const key = crypto.randomUUID();
		const sourceId = mode === "new" ? undefined : parent.id;
		const live = await sendReal(
			db,
			sender,
			box,
			key,
			email,
			"synthetic-test",
			sourceId,
			reply,
		);
		assert.equal(live.sender, draft.sender);
		assert.equal(
			calls[0].headers?.["In-Reply-To"],
			reply ? parent.message_id : undefined,
		);
		assert.equal(
			calls[0].headers?.References,
			reply ? `<ancestor@external.test> ${parent.message_id}` : undefined,
		);
		await db`DELETE FROM emails WHERE id=${draft_id}`;
		await db`DELETE FROM emails WHERE id=${parent.id}`;
		assert.equal(
			(
				await sendReal(
					db,
					sender,
					box,
					key,
					email,
					"synthetic-test",
					sourceId,
					reply,
				)
			).id,
			live.id,
		);
		assert.equal(calls.length, 1);
	});
}
test("missing/cross-mailbox sources and mismatched explicit send actions fail closed", async () => {
	const missing = crypto.randomUUID();
	assert.equal(
		(
			await call("drafts", {
				draft_mode: "reply",
				to: "x@example.test",
				body: "Hi",
			})
		).status,
		400,
	);
	assert.equal(
		(
			await call("drafts", {
				draft_mode: "forward",
				draft_source_id: missing,
				body: "Hi",
			})
		).status,
		404,
	);
	const other = "other@example.test";
	await store.createMailbox(other, "Other");
	const source = (await store.insert(other, {
		sender: other,
		recipient: box,
		subject: "Other",
		body: "Hi",
	}))!;
	assert.equal(
		(
			await call("drafts", {
				draft_mode: "reply",
				draft_source_id: source.id,
				body: "Hi",
			})
		).status,
		404,
	);
	const parent = (await store.insert(box, {
		sender: other,
		recipient: box,
		subject: "Local",
		body: "Hi",
	}))!;
	const saved = await call("drafts", {
		draft_mode: "forward",
		draft_source_id: parent.id,
		body: "Hi",
	});
	const { draft_id } = await saved.json();
	const payload = { draft_id, to: other, subject: "Fwd", html: "Hi" };
	assert.equal((await call(`emails/${parent.id}/reply`, payload)).status, 409);
	assert.equal(
		(await call("drafts", { draft_id, draft_mode: "reply", body: "Hi" }))
			.status,
		409,
	);
	await db`DELETE FROM emails WHERE id=${parent.id}`;
	assert.equal((await call("emails", payload)).status, 404);
});
test("migration retains legacy source without guessing mode or rewriting delivered RFC headers", async () => {
	const parent = (await store.insert(box, {
		sender: "legacy@example.test",
		recipient: box,
		subject: "Source",
		body: "Hi",
	}))!;
	const legacy = (await store.insert(box, {
		sender: box,
		recipient: "legacy@example.test",
		subject: "Re: misleading forward",
		body: "Hi",
		delivery_status: "draft",
		folder_id: "draft",
		in_reply_to: parent.id,
	}))!;
	const delivered = (await store.insert(box, {
		sender: box,
		recipient: "legacy@example.test",
		subject: "Delivered",
		body: "Hi",
		in_reply_to: parent.message_id!,
		delivery_status: "simulated",
		folder_id: "sent",
	}))!;
	await db`ALTER TABLE emails DROP COLUMN draft_mode, DROP COLUMN draft_source_id`;
	await db.unsafe(
		await readFile(
			new URL("../migrations/044_draft_intent.sql", import.meta.url),
			"utf8",
		),
	);
	const draft = await store.message(box, legacy.id);
	assert.equal(
		(await store.message(box, delivered.id)).in_reply_to,
		parent.message_id,
	);
	assert.equal(draft.draft_mode, null);
	assert.equal(draft.draft_source_id, parent.id);
	useUIStore.getState().startCompose({ mode: "reply", draftEmail: draft });
	assert.equal(useUIStore.getState().composeOptions.mode, "new");
	const sent = await call("emails", {
		draft_id: draft.id,
		to: "legacy@example.test",
		html: "Hi",
	});
	assert.equal(
		(await store.message(box, (await sent.json()).id)).in_reply_to,
		null,
	);
	assert.equal(
		(await store.message(box, parent.id)).message_id,
		parent.message_id,
	);
});
