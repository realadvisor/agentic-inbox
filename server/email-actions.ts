import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "./db";

export const messageFlagsSchema = z
	.object({ read: z.boolean().optional(), starred: z.boolean().optional() })
	.strict()
	.refine((value) => Object.keys(value).length > 0);
export async function updateMessageFlags(
	db: Database,
	mailbox: string,
	id: string,
	input: z.infer<typeof messageFlagsSchema>,
) {
	const flags = messageFlagsSchema.parse(input);
	const [row] =
		await db`UPDATE emails SET ${db(flags)} WHERE mailbox_id=${mailbox} AND id=${id} RETURNING id`;
	if (!row) throw new HTTPException(404, { message: "Email not found" });
	return { email_id: id, ...flags };
}
export async function setThreadRead(
	db: Database,
	mailbox: string,
	thread: string,
	read: boolean,
) {
	const rows =
		await db`UPDATE emails SET read=${read} WHERE mailbox_id=${mailbox} AND thread_id=${thread} RETURNING id`;
	if (!rows.length)
		throw new HTTPException(404, { message: "Conversation not found" });
	return { thread_id: thread, read, message_count: rows.length };
}
export const draftVersionSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const draftContentSchema = z.object({
	to: z.string().max(4000).default(""),
	cc: z.string().max(4000).default(""),
	bcc: z.string().max(4000).default(""),
	subject: z.string().max(1000).default(""),
	body: z.string().max(100_000),
});
// Hash the exact editable fields in SQL, avoiding timestamp precision loss and migrations.
export async function updateDraft(
	db: Database,
	mailbox: string,
	id: string,
	content: Partial<z.infer<typeof draftContentSchema>>,
	version?: string,
) {
	const input = draftContentSchema.partial().parse(content);
	const changes = Object.fromEntries(
		Object.entries(input)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [key === "to" ? "recipient" : key, value]),
	);
	if (!Object.keys(changes).length)
		throw new HTTPException(400, {
			message: "Provide at least one draft field to change",
		});
	if (version !== undefined) draftVersionSchema.parse(version);
	const [row] = await db`UPDATE emails SET ${db(changes)},date=clock_timestamp()
 WHERE mailbox_id=${mailbox} AND id=${id} AND delivery_status='draft'
 AND (${version ?? null}::text IS NULL OR md5(jsonb_build_array(recipient,cc,bcc,subject,body)::text)=${version ?? null})
 RETURNING id,md5(jsonb_build_array(recipient,cc,bcc,subject,body)::text) AS draft_version`;
	if (!row) {
		const [exists] =
			await db`SELECT id FROM emails WHERE mailbox_id=${mailbox} AND id=${id} AND delivery_status='draft'`;
		throw new HTTPException(exists ? 409 : 404, {
			message: exists
				? "Draft changed. Read it again before saving; do not overwrite newer edits."
				: "Draft not found",
		});
	}
	return {
		draft_id: row.id as string,
		draft_version: row.draft_version as string,
	};
}
