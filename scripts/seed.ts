import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { connect } from "../server/db";
import { InboxStore } from "../server/store";

const db = connect();
const store = new InboxStore(db);
const privacy = "privacy@realadvisor.com";
const info = "info@realadvisor.com";
try {
	for (const [email, name] of [
		[privacy, "Privacy"],
		[info, "Info"],
	]) {
		const existing = await db`SELECT id FROM mailboxes WHERE id = ${email}`;
		if (!existing.length) await store.createMailbox(email, name);
	}
	const samples = [
		{
			mailbox: privacy,
			id: "10000000-0000-4000-8000-000000000001",
			sender: "alex@example.test",
			subject: "Request to delete my account",
			body: "<p>Hello,</p><p>Please delete my account and personal data associated with this email address.</p><p>Thanks,<br>Alex (synthetic test contact)</p>",
			hours: 1,
		},
		{
			mailbox: privacy,
			id: "10000000-0000-4000-8000-000000000002",
			sender: "camille@example.test",
			subject: "Copy of my personal data",
			body: "<p>I would like a copy of the personal data associated with my account. I have attached a sample reference document.</p>",
			hours: 3,
		},
		{
			mailbox: privacy,
			id: "10000000-0000-4000-8000-000000000003",
			sender: "sam@example.test",
			subject: "Update my contact details",
			body: "<p>Could you correct the phone number on my profile? This message is a synthetic example.</p>",
			hours: 24,
		},
		{
			mailbox: info,
			id: "20000000-0000-4000-8000-000000000001",
			sender: "morgan@example.test",
			subject: "Question about a property valuation",
			body: "<p>Hello, can you explain how to update my property valuation?</p><p>Thanks, Morgan</p>",
			hours: 2,
		},
		{
			mailbox: info,
			id: "20000000-0000-4000-8000-000000000002",
			sender: "agency@example.test",
			subject: "Agency partnership enquiry",
			body: "<p>We would like to learn more about your agency offering.</p>",
			hours: 5,
		},
		{
			mailbox: info,
			id: "20000000-0000-4000-8000-000000000003",
			sender: "noise@example.test",
			subject: "Synthetic spam example",
			body: "<p>Sample unsolicited promotion for quarantine testing.</p>",
			hours: 8,
			folder_id: "spam",
		},
	];
	for (const sample of samples) {
		await store.insert(sample.mailbox, {
			...sample,
			recipient: sample.mailbox,
			date: new Date(Date.now() - sample.hours * 3_600_000),
			message_id: `<${sample.id}@example.test>`,
		});
	}
	await store.insert(privacy, {
		id: "10000000-0000-4000-8000-000000000004",
		sender: privacy,
		recipient: "sam@example.test",
		subject: "Re: Update my contact details",
		body: "<p>Thanks, Sam. We have received your request. This is a simulated reply.</p>",
		folder_id: "sent",
		delivery_status: "simulated",
		read: true,
		date: new Date(Date.now() - 23 * 3_600_000),
		thread_id: "10000000-0000-4000-8000-000000000003",
		in_reply_to: "<10000000-0000-4000-8000-000000000003@example.test>",
		message_id: "<sample-reply@example.test>",
	});
	const attachmentId = "30000000-0000-4000-8000-000000000001";
	const contents =
		"SYNTHETIC ATTACHMENT\nReference: DEMO-123\nThis file contains no real personal data.\n";
	await mkdir(resolve(".local/attachments"), { recursive: true });
	await writeFile(resolve(".local/attachments", attachmentId), contents);
	await db`INSERT INTO attachments (id, mailbox_id, email_id, filename, mimetype, size, storage_key)
		VALUES (${attachmentId}, ${privacy}, '10000000-0000-4000-8000-000000000002', 'sample-reference.txt', 'text/plain', ${Buffer.byteLength(
		contents
	)}, ${attachmentId}) ON CONFLICT DO NOTHING`;
	console.log(
		"Seeded Privacy and Info with synthetic messages. Existing messages were preserved; nothing was sent."
	);
} finally {
	await db.end();
}
