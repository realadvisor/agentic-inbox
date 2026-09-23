import { readFile } from "node:fs/promises";
import type { Database } from "../db";
import { migrate } from "../migrate";
import { InboxStore } from "../store";

export const presets = [
	{
		key: "reply",
		name: "Needs reply",
		color: "#ca8a04",
		question:
			"Does this conversation still need a reply from our mailbox? Consider actual sent replies; an acknowledgment alone may not answer the request.",
	},
	{
		key: "deletion",
		name: "Privacy: Deletion",
		color: "#7c3aed",
		question:
			"Does this conversation contain a request to delete personal data or an account, even if already answered?",
	},
	{
		key: "access",
		name: "Privacy: Data access",
		color: "#2563eb",
		question:
			"Does this conversation contain a request for a copy of personal data, even if already answered?",
	},
];
export async function setupPreview(db: Database) {
	await migrate(db);
	await db.unsafe(
		await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
	);
	const store = new InboxStore(db);
	for (const name of ["Privacy", "Info", "Bot"]) {
		const email = name.toLowerCase() + "@example.test";
		if (!(await db`SELECT id FROM mailboxes WHERE id=${email}`).length)
			await store.createMailbox(email, name);
	}
	for (const preset of presets) {
		await db`INSERT INTO tags(name,color) VALUES(${preset.name},${preset.color}) ON CONFLICT DO NOTHING`;
		const [tag] = await db`SELECT id FROM tags WHERE name=${preset.name}`;
		await db`INSERT INTO preview_classifiers(tag_id,question,fixture_question,fixture_key) VALUES(${tag.id},${preset.question},${preset.question},${preset.key}) ON CONFLICT DO NOTHING`;
	}
	const samples = [
		{
			name: "Alex",
			subject: "Please send my data and delete my account",
			body: "Please send me a copy of my personal data, then delete my account.",
			reply: true,
			deletion: true,
			access: true,
		},
		{
			name: "Camille",
			subject: "Suppression de mes données",
			body: "Bonjour, merci de supprimer mon compte et toutes mes données personnelles.",
			reply: true,
			deletion: true,
			access: false,
		},
		{
			name: "Sam",
			subject: "Please take care of this",
			body: "Could you take care of the attached request? [Attachment unavailable in this synthetic example.]",
			reply: null,
			deletion: null,
			access: null,
		},
		{
			name: "Billing",
			subject: "Payment received",
			body: "Your payment was received. This receipt is for your records.",
			reply: false,
			deletion: false,
			access: false,
		},
		{
			name: "Morgan",
			subject: "A copy of my personal data",
			body: "Please send me a copy of the personal data held about me.",
			reply: true,
			deletion: false,
			access: true,
		},
		{
			name: "Taylor",
			subject: "Thank you for the answer",
			body: "Thank you, that answers my question. Nothing else needed.",
			reply: false,
			deletion: false,
			access: false,
		},
	];
	let i = 0;
	for (const mailbox of [
		"privacy@example.test",
		"info@example.test",
		"bot@example.test",
	])
		for (const sample of samples) {
			i++;
			const id = "61000000-0000-4000-8000-" + String(i).padStart(12, "0");
			await store.insert(mailbox, {
				id,
				thread_id: id,
				sender: sample.name.toLowerCase() + "@customer.example.test",
				recipient: mailbox,
				subject: sample.subject,
				body:
					"<p>" + sample.body + "</p><p><em>Synthetic preview email.</em></p>",
				message_id: `<${id}@preview.test>`,
				date: new Date(Date.now() - i * 3600000),
			});
			await db`INSERT INTO preview_fixtures VALUES(${mailbox},${id},${db.json({ reply: sample.reply, deletion: sample.deletion, access: sample.access })}) ON CONFLICT DO NOTHING`;
		}
}
