import { test } from "node:test";
import assert from "node:assert/strict";
import type { Email } from "../app/types";
import {
	buildReplyAllFields,
	getLastReceivedMessage,
	getReplyAddress,
} from "../app/lib/replies";
import { isMailboxSelfAddress } from "../shared/mail-addresses";

function message(
	id: string,
	status: Email["delivery_status"],
	date: string,
	extra: Partial<Email> = {},
): Email {
	return {
		id,
		delivery_status: status,
		date,
		sender: "customer@example.test",
		recipient: "privacy@ingest.realadvisor.com",
		subject: "Synthetic request",
		read: true,
		starred: false,
		...extra,
	};
}

test("reply selects the latest received message across mixed delivery states, independently of sender aliases", () => {
	const older = message("older", "received", "2026-01-01");
	const incoming = message("incoming", "received", "2026-01-02", {
		reply_to: "reply@example.test",
		folder_id: "archive",
	});
	const outgoing = (
		["sent", "simulated", "sending", "failed", "unknown", "draft"] as const
	).map((status) =>
		message(status, status, "2026-01-03", {
			sender: "PRIVACY@realadvisor.com",
		}),
	);
	assert.equal(
		getLastReceivedMessage([older, ...outgoing, incoming]),
		incoming,
	);
	assert.equal(
		getReplyAddress(getLastReceivedMessage([incoming, ...outgoing])!),
		"reply@example.test",
	);
});

test("received status is authoritative even for self-originated messages", () => {
	const incoming = message("self", "received", "2026-01-01", {
		sender: "privacy@ingest.realadvisor.com",
	});
	assert.equal(getLastReceivedMessage([incoming]), incoming);
});

test("no received message returns no reply target, including draft-only and missing status", () => {
	assert.equal(getLastReceivedMessage([]), undefined);
	for (const status of [
		"sent",
		"simulated",
		"sending",
		"failed",
		"unknown",
		"draft",
		undefined,
	] as const) {
		assert.equal(
			getLastReceivedMessage([message("out", status, "2026-01-01")]),
			undefined,
		);
	}
	assert.equal(
		getLastReceivedMessage([
			message("draft", "received", "2026-01-01", { folder_id: "draft" }),
		]),
		undefined,
	);
	assert.equal(
		getLastReceivedMessage(
			[message("draft", "received", "2026-01-01")],
			new Set(["draft"]),
		),
		undefined,
	);
});

test("mailbox identity normalizes case, whitespace and public/ingest aliases in either direction", () => {
	assert.equal(
		isMailboxSelfAddress(
			" PRIVACY@REALADVISOR.COM ",
			" Privacy@Ingest.RealAdvisor.Com ",
		),
		true,
	);
	assert.equal(
		isMailboxSelfAddress(
			"privacy@ingest.realadvisor.com",
			"PRIVACY@realadvisor.com",
		),
		true,
	);
	assert.equal(
		isMailboxSelfAddress(" USER@EXAMPLE.TEST ", "user@example.test"),
		true,
	);
	assert.equal(
		isMailboxSelfAddress(
			"info@realadvisor.com",
			"privacy@ingest.realadvisor.com",
		),
		false,
	);
	assert.equal(
		isMailboxSelfAddress("privacy@ingest.example.test", "privacy@example.test"),
		false,
	);
	assert.equal(
		isMailboxSelfAddress(
			"privacy@realadvisor.com.evil.test",
			"privacy@ingest.realadvisor.com",
		),
		false,
	);
	assert.equal(isMailboxSelfAddress("", undefined), false);
});

test("Reply All prefers Reply-To, excludes both self aliases and deduplicates across To/Cc", () => {
	assert.deepEqual(
		buildReplyAllFields(
			{
				sender: "sender@example.test",
				reply_to: " Reply@Example.Test ",
				recipient:
					"privacy@ingest.realadvisor.com, PRIVACY@REALADVISOR.COM, reply@example.test, Colleague@example.test, COLLEAGUE@example.test, , info@realadvisor.com",
				cc: " colleague@example.test, COPY@example.test, copy@example.test, PRIVACY@INGEST.REALADVISOR.COM, privacy@realadvisor.com, REPLY@example.test ",
			},
			" Privacy@Ingest.RealAdvisor.Com ",
		),
		{
			to: "Reply@Example.Test, Colleague@example.test, info@realadvisor.com",
			cc: "COPY@example.test",
			showCcBcc: true,
		},
	);
});

test("Reply and Reply All fall back to sender without Reply-To; empty Cc stays hidden", () => {
	const original = {
		sender: " Sender@Example.Test ",
		reply_to: " ",
		recipient: "sender@example.test, privacy@ingest.realadvisor.com",
		cc: "privacy@realadvisor.com",
	};
	assert.equal(getReplyAddress(original), "Sender@Example.Test");
	assert.deepEqual(buildReplyAllFields(original, "privacy@realadvisor.com"), {
		to: "Sender@Example.Test",
		cc: "",
		showCcBcc: false,
	});
	assert.equal(
		getReplyAddress({ sender: "sender@example.test", reply_to: null }),
		"sender@example.test",
	);
});

test("Reply All in All excludes registered sender identities and their receiving mailboxes", () => {
	const senders = [
		{
			id: "privacy",
			email: "Privacy@RealAdvisor.Com",
			mailbox_id: "privacy@ingest.realadvisor.com",
			name: "Privacy",
			active: true,
		},
		{
			id: "support",
			email: "Support@Example.Test",
			mailbox_id: "helpdesk@example.test",
			name: "Support",
			active: true,
		},
	];
	assert.deepEqual(
		buildReplyAllFields(
			{
				sender: "customer@example.test",
				reply_to: "reply@example.test",
				recipient:
					"PRIVACY@realadvisor.com, privacy@ingest.realadvisor.com, colleague@example.test",
				cc: " SUPPORT@example.test, HELPDESK@example.test, COLLEAGUE@example.test, outsider@realadvisor.com ",
			},
			"all@ingest.realadvisor.com",
			senders,
		),
		{
			to: "reply@example.test, colleague@example.test",
			cc: "outsider@realadvisor.com",
			showCcBcc: true,
		},
	);
	assert.equal(
		isMailboxSelfAddress(" SUPPORT@EXAMPLE.TEST ", undefined, senders),
		true,
	);
	assert.equal(
		isMailboxSelfAddress("outsider@realadvisor.com", undefined, senders),
		false,
	);
});
