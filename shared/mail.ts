import { z } from "zod";

// Wire contracts shared by the HTTP API, store mappings and browser client.
export const draftModeSchema = z.enum(["new", "reply", "reply-all", "forward"]);
export type DraftMode = z.infer<typeof draftModeSchema>;

export const draftVersionSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const draftContentSchema = z.object({
	draft_mode: draftModeSchema.optional(),
	draft_source_id: z.string().uuid().nullable().optional(),
	sender_identity_id: z.string().min(1).max(254).optional(),
	to: z.string().max(4000).default(""),
	cc: z.string().max(4000).default(""),
	bcc: z.string().max(4000).default(""),
	subject: z.string().max(1000).default(""),
	body: z.string().max(100_000),
});
const text = z.string().max(100_000);
const id = z.string().uuid();
const recipients = z.union([
	z.string().email(),
	z.array(z.string().email()).min(1).max(50),
]);
export const sendEmailSchema = z
	.object({
		draft_mode: draftModeSchema.optional(),
		sender_identity_id: z.string().min(1).max(254).optional(),
		draft_id: id.optional(),
		to: recipients,
		cc: recipients.optional(),
		bcc: recipients.optional(),
		subject: z.string().max(1000).default(""),
		html: text.optional(),
		text: text.optional(),
	})
	.refine((value) => value.html || value.text, "Message body is required");
export const saveDraftSchema = draftContentSchema.extend({
	in_reply_to: id.optional(),
	thread_id: id.optional(),
	view: z.enum(["summary"]).optional(),
	draft_id: id.optional(),
	draft_version: draftVersionSchema.optional(),
});

export type SaveDraftInput = z.input<typeof saveDraftSchema>;
export type SendEmailInput = z.input<typeof sendEmailSchema>;
export type ParsedSendEmail = z.output<typeof sendEmailSchema>;

export const saveDraftResultSchema = z.object({
	draft_id: z.string(),
	draft_version: draftVersionSchema,
	sender: z.string(),
	sender_identity_id: z.string().nullable(),
});
export type SaveDraftResult = z.infer<typeof saveDraftResultSchema>;

// Only confirmed successes. Unknown/sending attempts are HTTP errors, never successes.
const sendIdentitySchema = z.object({
	sender: z.string(),
	sender_identity_id: z.string().nullable(),
});
export const sendResultSchema = z.discriminatedUnion("status", [
	sendIdentitySchema
		.extend({ id: z.string(), status: z.literal("sent") })
		.passthrough(),
	// The synthetic insert uses ON CONFLICT DO NOTHING; no invented ID on collision.
	sendIdentitySchema
		.extend({ id: z.string().optional(), status: z.literal("simulated") })
		.passthrough(),
]);
export type AcceptedSendResult = Extract<
	z.infer<typeof sendResultSchema>,
	{ status: "sent" }
>;
export type SendResult = z.infer<typeof sendResultSchema>;

// Compatibility view for UI components which can receive either lists or details.
export interface Tag {
	group_id?: string | null;
	group_name?: string | null;
	group_selection?: "single" | "multiple" | "score" | null;
	id: string;
	name: string;
	color: string;
}

export interface ConversationTag extends Tag {
	source: "manual" | "classifier";
	actor: string;
	created_at: string;
	updated_at: string;
}

export interface ConversationScore {
	group_id: string;
	name: string;
	score: number;
	maximum: number;
	confidence: number;
	needs_review: boolean;
}
export interface MailMessage {
	sender_identity_id?: string | null;
	scores?: ConversationScore[];
	thread_status?: import("shared/thread-status").ThreadStatus | null;
	delivery_status?:
		| "received"
		| "draft"
		| "simulated"
		| "sending"
		| "sent"
		| "failed"
		| "unknown";
	tags?: ConversationTag[];
	reply_to?: string | null;
	id: string;
	thread_id?: string | null;
	folder_id?: string | null;
	subject: string;
	sender: string;
	recipient: string;
	cc?: string;
	bcc?: string;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	in_reply_to?: string | null;
	draft_mode?: DraftMode | null;
	draft_source_id?: string | null;
	email_references?: string | null;
	message_id?: string | null;
	raw_headers?: string | null;
	attachments?: Attachment[];
	snippet?: string | null;
	// Thread aggregate fields (only present in threaded list view)
	thread_count?: number;
	thread_unread_count?: number;
	participants?: string;
	needs_reply?: boolean;
	has_draft?: boolean;
	draft_version?: string | null;
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

// Read schemas validate JSON, not SQL driver rows (dates are serialized at HTTP).
// These schemas tolerate additive fields; they are never used to project/strip
// HTTP responses. Existing SQL projections continue to own wire fields.
const tagSchema = z.object({
	id: z.string(),
	name: z.string(),
	color: z.string(),
	group_id: z.string().nullable().optional(),
	group_name: z.string().nullable().optional(),
	group_selection: z
		.enum(["single", "multiple", "score"])
		.nullable()
		.optional(),
	source: z.enum(["manual", "classifier"]),
	actor: z.string(),
	created_at: z.string(),
	updated_at: z.string(),
});
const scoreSchema = z.object({
	group_id: z.string(),
	name: z.string(),
	score: z.number(),
	maximum: z.number(),
	confidence: z.number(),
	needs_review: z.boolean(),
});
const attachmentSchema = z.object({
	id: z.string(),
	filename: z.string(),
	mimetype: z.string(),
	size: z.number(),
	content_id: z.string().optional(),
	disposition: z.string().optional(),
});
export const messageSummarySchema = z.object({
	id: z.string(),
	mailbox_id: z.string(),
	folder_id: z.string(),
	thread_id: z.string(),
	subject: z.string(),
	sender: z.string(),
	recipient: z.string(),
	cc: z.string(),
	bcc: z.string(),
	date: z.string(),
	read: z.boolean(),
	starred: z.boolean(),
	message_id: z.string(),
	in_reply_to: z.string().nullable(),
	email_references: z.string().nullable(),
	reply_to: z.string().nullable(),
	sender_identity_id: z.string().nullable(),
	draft_mode: draftModeSchema.nullable(),
	draft_source_id: z.string().nullable(),
	delivery_status: z.enum([
		"received",
		"draft",
		"simulated",
		"sending",
		"sent",
		"failed",
		"unknown",
	]),
	snippet: z.string(),
	tags: z.array(tagSchema),
	scores: z.array(scoreSchema),
});
export type MessageSummary = z.infer<typeof messageSummarySchema>;
// Aggregates are returned for both threaded and unthreaded lists/search.
export const conversationSummarySchema = messageSummarySchema.extend({
	thread_status: z.enum(["open", "done"]).nullable(),
	thread_count: z.number(),
	needs_reply: z.boolean().optional(), // Reserved legacy UI field; current API does not compute it.
	thread_unread_count: z.number(),
	participants: z.string(),
	has_draft: z.boolean(),
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export const messageDetailSchema = messageSummarySchema.extend({
	body: z.string(),
	raw_headers: z.string().nullable(),
	draft_version: draftVersionSchema.nullable(),
	attachments: z.array(attachmentSchema),
});
export type MessageDetail = z.infer<typeof messageDetailSchema>;
export const draftDetailSchema = messageDetailSchema.extend({
	delivery_status: z.literal("draft"),
});
export type DraftDetail = z.infer<typeof draftDetailSchema>;
export const mailListResponseSchema = z.object({
	emails: z.array(
		conversationSummarySchema.extend({
			body: z.string().optional(),
			raw_headers: z.string().nullable().optional(),
		}),
	),
	totalCount: z.number(),
});
// Default lists additionally contain body/raw headers, but do not load attachments
// or draft_version. Do not treat list rows as detail records when opening a draft.
export type MailListResponse = z.infer<typeof mailListResponseSchema>;
