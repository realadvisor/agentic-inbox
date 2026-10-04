import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildInitialComposeFields,
	resolveComposeSender,
} from "../app/lib/compose-fields";
import {
	prepareComposeSend,
	type ComposeSubmission,
} from "../app/lib/compose-send";
import type { Email } from "../app/types";

const sender = {
	id: "sender",
	email: "self@example.test",
	mailbox_id: "mailbox",
	name: "Self",
	active: true,
};
const config = { senders: [sender], default_sender_identity_id: sender.id };
const draft: Email = {
	id: "draft",
	sender: "self@example.test",
	sender_identity_id: sender.id,
	recipient: "customer@example.test, other@example.test",
	cc: "copy@example.test",
	bcc: "hidden@example.test",
	subject: "Saved",
	body: "<p>Original saved content</p>",
	date: "2026-01-01",
	read: true,
	starred: false,
	draft_mode: "forward",
	draft_source_id: "source",
};

test("persisted drafts initialize identically for direct send and editing without re-quoting or appending signatures", () => {
	const fields = buildInitialComposeFields(
		{ mode: "forward", draftEmail: draft },
		"self@example.test",
		"NEW SIGNATURE",
		config.senders,
	);
	assert.deepEqual(fields, {
		to: draft.recipient,
		cc: draft.cc,
		bcc: draft.bcc,
		subject: draft.subject,
		body: draft.body,
		showCcBcc: true,
	});
	assert.equal(
		resolveComposeSender(
			config,
			{ mode: "forward", draftEmail: draft },
			"mailbox",
		),
		sender.id,
	);
});

test("saved unavailable identities never silently fall back to the current default", () => {
	assert.equal(
		resolveComposeSender(
			config,
			{
				mode: "new",
				draftEmail: { ...draft, sender_identity_id: "disabled-identity" },
			},
			"mailbox",
		),
		"disabled-identity",
	);
});

const input: ComposeSubmission = {
	mailboxId: "mailbox",
	sendScope: "scope",
	mode: "new",
	sender,
	fields: {
		to: "customer@example.test",
		cc: "",
		bcc: "",
		subject: "Test",
		body: "",
	},
};
test("every send surface rejects empty recipients, inactive sender and missing explicit source before delivery", () => {
	assert.throws(
		() =>
			prepareComposeSend({ ...input, fields: { ...input.fields, to: " , " } }),
		/recipient/,
	);
	assert.throws(
		() =>
			prepareComposeSend({ ...input, sender: { ...sender, active: false } }),
		/available sender/,
	);
	for (const mode of ["reply", "reply-all", "forward"] as const)
		assert.throws(
			() => prepareComposeSend({ ...input, mode }),
			/original message is missing/,
		);
});
