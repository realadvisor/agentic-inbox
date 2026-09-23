import { HTTPException } from "hono/http-exception";
import type { Database } from "./db";
import { InboxStore } from "./store";
import { mailboxConfig } from "./mailboxes";
export interface OutgoingMail {
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	html?: string;
	text?: string;
}
export interface MailSender {
	send(
		mail: OutgoingMail & {
			from: string;
			replyTo: string;
			headers?: Record<string, string>;
		},
	): Promise<{ messageId: string }>;
}
export async function sendReal(
	db: Database,
	sender: MailSender,
	mailbox: string,
	requestId: string,
	input: OutgoingMail,
	actor: string,
	parentId?: string,
	isReply = false,
) {
	const config = await mailboxConfig(db, mailbox);
	if (!config)
		throw new HTTPException(403, {
			message: "Mailbox is not enabled for sending",
		});
	const count = [input.to, input.cc, input.bcc].flatMap((x) =>
		x ? (Array.isArray(x) ? x : [x]) : [],
	).length;
	if (count > 50)
		throw new HTTPException(400, {
			message: "Maximum 50 recipients across To, Cc, and Bcc",
		});
	const hash = Array.from(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(JSON.stringify({ input, parentId, isReply })),
			),
		),
		(x) => x.toString(16).padStart(2, "0"),
	).join("");
	const store = new InboxStore(db);
	const parent = parentId ? await store.message(mailbox, parentId) : undefined;
	const join = (s: string | string[] | undefined) =>
		Array.isArray(s) ? s.join(", ") : (s ?? "");
	const claimed = await db.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtext(${mailbox + requestId}))`;
		const [existing] =
			await tx`SELECT r.payload_hash,e.id,e.delivery_status FROM outbound_requests r JOIN emails e ON e.id=r.email_id WHERE r.mailbox_id=${mailbox} AND r.request_id=${requestId}`;
		if (existing) {
			if (existing.payload_hash !== hash)
				throw new HTTPException(409, {
					message: "Request key was already used for different content",
				});
			return {
				id: existing.id as string,
				status: existing.delivery_status as string,
				existing: true,
			};
		}
		const id = crypto.randomUUID();
		const body =
			input.html ??
			(input.text ?? "")
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/\n/g, "<br>");
		await tx`INSERT INTO emails (id,mailbox_id,folder_id,subject,sender,recipient,cc,bcc,body,thread_id,message_id,in_reply_to,email_references,delivery_status,read) VALUES (${id},${mailbox},'sent',${input.subject},${config.from},${join(input.to)},${join(input.cc)},${join(input.bcc)},${body},${isReply ? (parent?.thread_id ?? id) : id},${`<${id}@realadvisor.com>`},${isReply ? (parent?.message_id ?? null) : null},${isReply ? [parent?.email_references, parent?.message_id].filter(Boolean).join(" ") : null},'sending',true)`;
		await tx`INSERT INTO outbound_requests (mailbox_id,request_id,payload_hash,email_id,actor) VALUES (${mailbox},${requestId},${hash},${id},${actor})`;
		return { id, status: "sending", existing: false };
	});
	if (claimed.existing) {
		if (claimed.status === "sent") return { id: claimed.id, status: "sent" };
		throw new HTTPException(409, {
			message: `Previous send is ${claimed.status}; inspect it before trying again`,
		});
	}
	let result;
	try {
		result = await sender.send({
			...input,
			from: config.from,
			replyTo: config.from,
			headers:
				isReply && parent?.message_id
					? {
							"In-Reply-To": parent.message_id,
							References: [parent.email_references, parent.message_id]
								.filter(Boolean)
								.join(" "),
						}
					: undefined,
		});
	} catch (error) {
		// Delivery can be ambiguous after a timeout. Never automatically resend.
		await db`UPDATE emails SET delivery_status='unknown' WHERE id=${claimed.id}`;
		console.error(
			"Outbound result unknown",
			claimed.id,
			error instanceof Error ? error.name : "provider error",
		);
		throw new HTTPException(502, {
			message:
				"Send was not confirmed. Check delivery before composing another message.",
		});
	}
	await db`UPDATE emails SET delivery_status='sent',message_id=${result.messageId} WHERE id=${claimed.id}`;
	return { id: claimed.id, status: "sent" };
}
