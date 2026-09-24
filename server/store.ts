import { HTTPException } from "hono/http-exception";
import type {
	Email,
	Mailbox,
	Attachment,
	ConversationTag,
} from "../app/types/index";
import { FOLDER_DISPLAY_NAMES } from "../shared/folders";
import type { Database } from "./db";

export interface MessageRow extends Omit<Email, "date"> {
	date: Date;
	mailbox_id: string;
	delivery_status:
		| "received"
		| "draft"
		| "simulated"
		| "sending"
		| "sent"
		| "failed"
		| "unknown";
}
export interface NewMessage {
	id?: string;
	sender: string;
	recipient: string;
	subject: string;
	body: string;
	cc?: string;
	bcc?: string;
	date?: Date;
	folder_id?: string;
	thread_id?: string;
	message_id?: string;
	in_reply_to?: string;
	email_references?: string;
	delivery_status?: MessageRow["delivery_status"];
	read?: boolean;
}

export function serialize(row: MessageRow) {
	return {
		...row,
		date: row.date.toISOString(),
		snippet: row.body?.replace(/<[^>]*>/g, " ").slice(0, 180),
	};
}

function required<T>(row: T | undefined): T {
	if (!row) throw new HTTPException(404, { message: "Not found" });
	return row;
}

export class InboxStore {
	constructor(
		readonly db: Database,
		readonly options: { classifierPreview?: boolean } = {},
	) {}

	async tagsForThreads(mailbox: string, threads: string[]) {
		if (!threads.length) return [];
		return this.db<
			(ConversationTag & { thread_id: string })[]
		>`SELECT t.id, t.name, t.color,t.group_id,g.name AS group_name,g.selection AS group_selection, ct.thread_id, ct.source, ct.actor, ct.created_at, ct.updated_at
		FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id
		LEFT JOIN tag_groups g ON g.id=t.group_id
		WHERE ct.mailbox_id=${mailbox} AND ct.thread_id IN ${this.db([...new Set(threads)])} AND ct.removed_at IS NULL AND t.archived_at IS NULL ORDER BY g.name,t.position,lower(t.name), t.id`;
	}

	async listMailboxes() {
		return this.db<Mailbox[]>`SELECT * FROM mailboxes ORDER BY name`;
	}
	async mailbox(id: string) {
		return required(
			(await this.db<Mailbox[]>`SELECT * FROM mailboxes WHERE id = ${id}`)[0],
		);
	}
	async createMailbox(email: string, name: string, actor?: string) {
		return this.db.begin(async (tx) => {
			const [mailbox] = await tx<
				Mailbox[]
			>`INSERT INTO mailboxes (id, email, name, created_by) VALUES (${email}, ${email}, ${name}, ${actor ?? null}) RETURNING *`;
			for (const [id, label] of Object.entries(FOLDER_DISPLAY_NAMES)) {
				await tx`INSERT INTO folders (mailbox_id, id, name, is_deletable) VALUES (${email}, ${id}, ${label}, false)`;
			}
			return required(mailbox);
		});
	}
	async folders(mailbox: string) {
		return this
			.db`SELECT f.*, count(e.id) FILTER (WHERE NOT e.read)::int AS "unreadCount"
			FROM folders f LEFT JOIN emails e ON e.mailbox_id = f.mailbox_id AND e.folder_id = f.id
			WHERE f.mailbox_id = ${mailbox} GROUP BY f.mailbox_id, f.id ORDER BY f.is_deletable, f.name`;
	}
	async message(mailbox: string, id: string) {
		const row = required(
			(
				await this.db<
					MessageRow[]
				>`SELECT * FROM emails WHERE mailbox_id = ${mailbox} AND id = ${id}`
			)[0],
		);
		const attachments = await this.db<
			Attachment[]
		>`SELECT id, filename, mimetype, size FROM attachments WHERE mailbox_id = ${mailbox} AND email_id = ${id}`;
		return {
			...serialize(row),
			attachments,
			tags: await this.tagsForThreads(mailbox, [row.thread_id!]),
		};
	}
	async thread(mailbox: string, thread: string) {
		const rows = await this.db<
			MessageRow[]
		>`SELECT * FROM emails WHERE mailbox_id = ${mailbox} AND thread_id = ${thread} ORDER BY date, id`;
		const attachments = await this.db<
			(Attachment & { email_id: string })[]
		>`SELECT a.id, a.email_id, a.filename, a.mimetype, a.size
			FROM attachments a JOIN emails e ON e.id = a.email_id AND e.mailbox_id = a.mailbox_id
			WHERE e.mailbox_id = ${mailbox} AND e.thread_id = ${thread}`;
		const tags = await this.tagsForThreads(mailbox, [thread]);
		return rows.map((row) => ({
			tags,
			...serialize(row),
			attachments: attachments.filter((a) => a.email_id === row.id),
		}));
	}
	async insert(mailbox: string, input: NewMessage) {
		const id = input.id ?? crypto.randomUUID();
		const [row] = await this.db<MessageRow[]>`INSERT INTO emails ${this.db({
			id,
			mailbox_id: mailbox,
			sender: input.sender,
			recipient: input.recipient,
			subject: input.subject,
			body: input.body,
			cc: input.cc ?? "",
			bcc: input.bcc ?? "",
			date: input.date ?? new Date(),
			folder_id: input.folder_id ?? "inbox",
			thread_id: input.thread_id ?? id,
			message_id: input.message_id ?? `<${id}@prototype.invalid>`,
			in_reply_to: input.in_reply_to ?? null,
			email_references: input.email_references ?? null,
			delivery_status: input.delivery_status ?? "received",
			read: input.read ?? false,
		})} ON CONFLICT (mailbox_id, message_id) DO NOTHING RETURNING *`;
		return row ? serialize(row) : null;
	}
	async list(mailbox: string, params: Record<string, string>) {
		const page = Math.max(1, Number(params.page) || 1);
		const limit = Math.min(100, Math.max(1, Number(params.limit) || 25));
		const conditions = [this.db`e.mailbox_id = ${mailbox}`];
		const tagIds = [
			...new Set([
				...(params.tag_ids?.split(",").filter(Boolean) ?? []),
				...(params.tag_id ? [params.tag_id] : []),
			]),
		];
		if (tagIds.length) {
			if (params.tag_match === "any")
				conditions.push(
					this
						.db`EXISTS (SELECT 1 FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.mailbox_id=e.mailbox_id AND ct.thread_id=e.thread_id AND ct.tag_id IN ${this.db(tagIds)} AND ct.removed_at IS NULL AND t.archived_at IS NULL)`,
				);
			else
				conditions.push(
					this
						.db`(SELECT count(DISTINCT ct.tag_id) FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE ct.mailbox_id=e.mailbox_id AND ct.thread_id=e.thread_id AND ct.tag_id IN ${this.db(tagIds)} AND ct.removed_at IS NULL AND t.archived_at IS NULL)=${tagIds.length}`,
				);
		}

		if (params.needs_review === "true") {
			const preview = this.options.classifierPreview;
			conditions.push(this.db`EXISTS (
				SELECT 1 FROM ${this.db(preview ? "preview_classifications" : "conversation_classifications")} r
				JOIN ${this.db(preview ? "preview_classifiers" : "classifiers")} c ON c.id=r.classifier_id
				WHERE r.mailbox_id=e.mailbox_id AND r.thread_id=e.thread_id
				AND c.enabled ${preview ? this.db`AND r.answer IS NULL` : this.db`AND (r.answer IS NULL OR r.error='group_conflict')`}
				${preview ? this.db`` : this.db`AND r.revision=c.revision AND r.status IN ('review','error')`}
				AND NOT tag_manually_overridden(r.mailbox_id,r.thread_id,c.tag_id)
			)`);
		}
		if (params.folder) conditions.push(this.db`e.folder_id = ${params.folder}`);
		if (params.thread_id)
			conditions.push(this.db`e.thread_id = ${params.thread_id}`);
		if (params.query) {
			const value = `%${escapeLike(params.query)}%`;
			conditions.push(
				this
					.db`(e.subject ILIKE ${value} OR e.sender ILIKE ${value} OR e.recipient ILIKE ${value} OR e.body ILIKE ${value})`,
			);
		}
		for (const [parameter, column] of [
			["from", "sender"],
			["to", "recipient"],
			["subject", "subject"],
		]) {
			if (params[parameter])
				conditions.push(
					this.db`${this.db(`e.${column}`)} ILIKE ${`%${escapeLike(
						params[parameter],
					)}%`}`,
				);
		}
		for (const [parameter, column] of [
			["is_read", "read"],
			["is_starred", "starred"],
		]) {
			if (params[parameter] !== undefined)
				conditions.push(
					this.db`${this.db(`e.${column}`)} = ${params[parameter] === "true"}`,
				);
		}
		if (params.date_start)
			conditions.push(this.db`e.date >= ${params.date_start}::timestamptz`);
		if (params.date_end)
			conditions.push(this.db`e.date < ${params.date_end}::timestamptz`);
		if (params.has_attachment === "true")
			conditions.push(
				this
					.db`EXISTS (SELECT 1 FROM attachments a WHERE a.email_id = e.id AND a.mailbox_id = e.mailbox_id)`,
			);
		const where = conditions.reduce((a, b) => this.db`${a} AND ${b}`);
		const threaded = params.threaded === "true";
		const selection = threaded
			? this
					.db`SELECT DISTINCT ON (e.thread_id) e.* FROM emails e WHERE ${where} ORDER BY e.thread_id, e.date DESC, e.id`
			: this.db`SELECT e.* FROM emails e WHERE ${where}`;
		const [count] = await this.db<
			{ count: number }[]
		>`SELECT count(*)::int AS count FROM (${selection}) selected`;
		const column = ["date", "subject", "sender"].includes(params.sortColumn)
			? params.sortColumn
			: "date";
		const direction =
			params.sortDirection === "ASC" ? this.db`ASC` : this.db`DESC`;
		const rows = await this.db<MessageRow[]>`SELECT selected.*,
			(SELECT count(*)::int FROM emails t WHERE t.mailbox_id = selected.mailbox_id AND t.thread_id = selected.thread_id) AS thread_count,
			(SELECT count(*)::int FROM emails t WHERE t.mailbox_id = selected.mailbox_id AND t.thread_id = selected.thread_id AND NOT t.read) AS thread_unread_count,
			EXISTS (SELECT 1 FROM emails t WHERE t.mailbox_id = selected.mailbox_id AND t.thread_id = selected.thread_id AND t.folder_id = 'draft') AS has_draft,
			(SELECT string_agg(DISTINCT t.sender, ', ') FROM emails t WHERE t.mailbox_id = selected.mailbox_id AND t.thread_id = selected.thread_id) AS participants
			FROM (${selection}) selected ORDER BY ${this.db(
				column,
			)} ${direction}, id LIMIT ${limit} OFFSET ${(page - 1) * limit}`;
		const tags = await this.tagsForThreads(
			mailbox,
			rows.map((row) => row.thread_id!),
		);
		return {
			emails: rows.map((row) => ({
				...serialize(row),
				tags: tags.filter((tag) => tag.thread_id === row.thread_id),
			})),
			totalCount: count.count,
		};
	}
}

function escapeLike(value: string) {
	return value.replace(/[\\%_]/g, "\\$&");
}
