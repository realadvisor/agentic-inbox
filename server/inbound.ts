import PostalMime, { type Address } from "postal-mime";
import type { Database } from "./db";
import { mailboxConfig } from "./mailboxes";
export interface ObjectStore {
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(key: string, value: ArrayBuffer | Uint8Array | string): Promise<unknown>;
}
export interface InboundMessage {
	to: string;
	from: string;
	raw: ReadableStream;
	rawSize: number;
	setReject(reason: string): void;
}
const escape = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");
const addresses = (list: Address[] = []): string =>
	list
		.flatMap((a) =>
			a.address ? [a.address] : (a.group?.map((x) => x.address) ?? []),
		)
		.join(", ");
export async function ingest(
	message: InboundMessage,
	db: Database,
	objects: ObjectStore,
) {
	const mailbox = message.to.toLowerCase();
	if (!(await mailboxConfig(db, mailbox))) {
		message.setReject("Unknown mailbox");
		return;
	}
	if (message.rawSize > 10 * 1024 * 1024) {
		message.setReject("Message exceeds 10 MiB");
		return;
	}
	// Bound actual streamed bytes as well as the envelope's advertised size.
	const reader = message.raw.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 10 * 1024 * 1024) {
				await reader.cancel();
				message.setReject("Message exceeds 10 MiB");
				return;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const raw = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		raw.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const hash = Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", raw)),
		(x) => x.toString(16).padStart(2, "0"),
	).join("");
	const rawKey = `raw/${mailbox}/${hash}.eml`;
	// Persist the original before parsing so an ingestion failure remains recoverable.
	await objects.put(rawKey, raw);
	await db`INSERT INTO inbound_recovery(mailbox_id, raw_hash, raw_storage_key, envelope_from, size)
 VALUES(${mailbox},${hash},${rawKey},${message.from.slice(0, 1000)},${raw.byteLength}) ON CONFLICT(mailbox_id,raw_hash) DO NOTHING`;
	let stage = "parse";
	try {
		const parsed = await PostalMime.parse(raw, {
			maxNestingDepth: 30,
			maxHeadersSize: 256000,
		});
		stage = "delivery";
		const messageId = parsed.messageId ?? `<${hash}@ingest.realadvisor.com>`;
		await db.begin(async (tx) => {
			// Serialize ingestion per mailbox for duplicate delivery and thread assignment.
			await tx`SELECT pg_advisory_xact_lock(hashtext(${mailbox}))`;
			const [existing] =
				await tx`SELECT id FROM emails WHERE mailbox_id=${mailbox} AND message_id=${messageId}`;
			if (existing) {
				await tx`UPDATE inbound_recovery SET status='complete', updated_at=now() WHERE mailbox_id=${mailbox} AND raw_hash=${hash}`;
				return;
			}
			const id = crypto.randomUUID();
			const refs = [
				parsed.inReplyTo,
				...(parsed.references?.match(/<[^>]+>/g) ?? []).reverse(),
			].filter((s): s is string => Boolean(s));
			let thread = id;
			for (const ref of refs) {
				const [parent] =
					await tx`SELECT thread_id FROM emails WHERE mailbox_id=${mailbox} AND message_id=${ref}`;
				if (parent) {
					thread = parent.thread_id;
					break;
				}
			}
			const date = parsed.date ? new Date(parsed.date) : new Date();
			await tx`INSERT INTO emails (id,mailbox_id,folder_id,subject,sender,recipient,cc,date,body,in_reply_to,email_references,thread_id,message_id,raw_storage_key,reply_to)
   VALUES (${id},${mailbox},'inbox',${parsed.subject ?? ""},${addresses(parsed.from ? [parsed.from] : []) || message.from},${addresses(parsed.to) || mailbox},${addresses(parsed.cc)},${Number.isNaN(date.getTime()) ? new Date() : date},${parsed.html ?? escape(parsed.text ?? "")},${parsed.inReplyTo ?? null},${parsed.references ?? null},${thread},${messageId},${rawKey},${addresses(parsed.replyTo) || null})`;
			// Address indexing is transactional with delivery; MIME supplies the optional name.
			if (parsed.from?.address && parsed.from.name?.trim()) {
				await tx`UPDATE mailbox_contacts SET name=${parsed.from.name.trim().slice(0, 200)}
				WHERE mailbox_id=${mailbox} AND email=${parsed.from.address.toLowerCase().trim()}`;
			}

			for (const [index, attachment] of parsed.attachments.entries()) {
				const key = crypto.randomUUID();
				const content = attachment.content;
				if (typeof content === "string")
					throw new Error("Unexpected attachment encoding");
				// Retry overwrites the same private object instead of accumulating orphans.
				const storageKey = `inbound-attachments/${mailbox}/${hash}/${index}`;
				await objects.put(storageKey, content);
				await tx`INSERT INTO attachments (id,mailbox_id,email_id,filename,mimetype,size,storage_key) VALUES (${key},${mailbox},${id},${attachment.filename ?? "attachment"},${attachment.mimeType},${content.byteLength},${storageKey})`;
			}
			await tx`UPDATE inbound_recovery SET status='complete', updated_at=now() WHERE mailbox_id=${mailbox} AND raw_hash=${hash}`;
		});
	} catch (error) {
		// Never persist parser/provider messages: they may contain message content or credentials.
		await db`UPDATE inbound_recovery SET status='failed', failure_stage=${stage}, updated_at=now() WHERE mailbox_id=${mailbox} AND raw_hash=${hash} AND status<>'complete'`;
		throw error;
	}
}
