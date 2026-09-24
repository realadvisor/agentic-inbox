import { classifierApi } from "./classification/api";
import { setConversationTags } from "./tags";
import { documentation } from "./docs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Database } from "./db";
import { InboxStore, type MessageRow } from "./store";

import { sendReal, type MailSender } from "./outbound";
import { liveSender, mailboxConfig } from "./mailboxes";

const text = z.string().max(100_000);
const id = z.string().uuid();
const recipients = z.union([
	z.string().email(),
	z.array(z.string().email()).min(1).max(50),
]);
const sendSchema = z
	.object({
		to: recipients,
		cc: recipients.optional(),
		bcc: recipients.optional(),
		subject: z.string().max(1000).default(""),
		html: text.optional(),
		text: text.optional(),
	})
	.refine((value) => value.html || value.text, "Message body is required");
const draftSchema = z.object({
	to: z.string().max(4000).default(""),
	cc: z.string().max(4000).default(""),
	bcc: z.string().max(4000).default(""),
	subject: z.string().max(1000).default(""),
	body: text,
	in_reply_to: id.optional(),
	thread_id: id.optional(),
	draft_id: id.optional(),
});
const tagSchema = z
	.object({
		name: z.string().trim().min(1).max(80),
		color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
	})
	.strict();
const querySchema = z.object({
	tag_id: id.optional(),
	needs_review: z.enum(["true", "false"]).optional(),
	page: z.coerce.number().int().min(1).max(100000).optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	thread_id: id.optional(),
	date_start: z.string().datetime({ offset: true }).optional(),
	date_end: z.string().datetime({ offset: true }).optional(),
	is_read: z.enum(["true", "false"]).optional(),
	is_starred: z.enum(["true", "false"]).optional(),
});

export interface ApiOptions {
	classifierPreview?: boolean;
	classifiersEnabled?: boolean;
	kickClassifiers?: () => void;
	previewRoutes?: Hono;
	readAttachment: (key: string) => Promise<Uint8Array | null>;
	// Remote authentication is enforced by the Worker before it constructs this API.
	origin?: string;
	mode?: "live" | "synthetic";
	sender?: MailSender;
	actor?: string;
	mailboxAdmins?: string[];
	mailboxCreationEnabled?: boolean;
}

export function createApi(db: Database, options: ApiOptions) {
	const store = new InboxStore(db, {
		classifierPreview: options.classifierPreview,
	});
	const isLive = options.mode === "live";
	const canCreate =
		!isLive ||
		(options.mailboxCreationEnabled === true &&
			!!options.actor &&
			(options.mailboxAdmins ?? []).includes(options.actor.toLowerCase()));
	const app = new Hono();
	app.use("*", bodyLimit({ maxSize: 256_000 }));
	app.use("*", async (c, next) => {
		// Local origin checks are retained; the Worker authenticates remote requests.
		const host = c.req.header("host") ?? new URL(c.req.url).host;
		if (
			options.origin
				? host !== new URL(options.origin).host
				: !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
		)
			return c.json({ error: "Local access only" }, 403);
		const origin = c.req.header("origin");
		if (
			origin &&
			(options.origin
				? origin !== options.origin
				: !/^http:\/\/(localhost|127\.0\.0\.1):(4310|4311)$/.test(origin))
		)
			return c.json({ error: "Cross-origin access denied" }, 403);
		if (
			["POST", "PUT", "PATCH"].includes(c.req.method) &&
			!c.req.header("content-type")?.startsWith("application/json")
		) {
			return c.json({ error: "Use application/json" }, 415);
		}
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.onError((error, c) => {
		if (error instanceof HTTPException)
			return c.json({ error: error.message }, error.status);
		if (error instanceof z.ZodError || error instanceof SyntaxError)
			return c.json({ error: "Invalid request", details: error.message }, 400);
		if ("code" in error && error.code === "23505")
			return c.json({ error: "Already exists" }, 409);
		if ("code" in error && error.code === "23503")
			return c.json(
				{ error: "Referenced item does not exist or is still in use" },
				409,
			);
		console.error("Inbox request failed:", error.message);
		return c.json({ error: "Request failed" }, 500);
	});
	app.route("/", documentation());
	app.get("/api/health", async (c) => {
		await db`SELECT version FROM inbox_migrations WHERE version = 1`;
		return c.json({
			status: "ok",
			storage: "postgres",
			mode: options.mode ?? "synthetic",
		});
	});
	app.get("/api/v1/config", (c) =>
		c.json({
			domains:
				options.mode === "live" ? ["ingest.realadvisor.com"] : ["example.test"],
			emailAddresses: [],
			canCreateMailboxes: canCreate,
			classifierPreview: !isLive && options.classifierPreview === true,
			classifiersEnabled: options.classifiersEnabled === true,
			canManageClassifiers:
				options.classifiersEnabled === true &&
				(!isLive ||
					(options.mailboxAdmins ?? []).includes(options.actor ?? "")),
			canDeleteMailboxes: !isLive,
			mode: options.mode ?? "synthetic",
		}),
	);
	app.get("/api/v1/tags", async (c) =>
		c.json(await db`SELECT * FROM tags ORDER BY lower(name), id`),
	);
	app.post("/api/v1/tags", async (c) => {
		const input = tagSchema.parse(await c.req.json());
		const [tag] = await db`INSERT INTO tags ${db(input)} RETURNING *`;
		return c.json(tag, 201);
	});
	app.put("/api/v1/tags/:tagId", async (c) => {
		const input = tagSchema.parse(await c.req.json());
		const [tag] =
			await db`UPDATE tags SET ${db(input)}, updated_at=now() WHERE id=${id.parse(c.req.param("tagId"))} RETURNING *`;
		if (!tag) throw new HTTPException(404);
		return c.json(tag);
	});
	app.delete("/api/v1/tags/:tagId", async (c) => {
		if (c.req.query("confirm") !== "true")
			throw new HTTPException(400, {
				message: "Deleting a shared tag requires confirm=true",
			});
		const rows =
			await db`DELETE FROM tags WHERE id=${id.parse(c.req.param("tagId"))} RETURNING id`;
		if (!rows.length) throw new HTTPException(404);
		return c.body(null, 204);
	});
	app.get("/api/v1/mailboxes", async (c) =>
		c.json(
			(await store.listMailboxes()).filter(
				(m) => options.mode !== "live" || liveSender(m.id),
			),
		),
	);
	app.post("/api/v1/mailboxes", async (c) => {
		if (!canCreate)
			throw new HTTPException(403, {
				message: "Mailbox creation requires an enabled mailbox administrator",
			});
		const input = z
			.object({
				email: z.string().email().max(254),
				name: z.string().trim().min(1).max(120),
			})
			.parse(await c.req.json());
		const address = input.email.toLowerCase();
		if (isLive && !liveSender(address))
			throw new HTTPException(400, {
				message:
					"Use a valid address on ingest.realadvisor.com (letters, numbers, dots, hyphens or underscores; maximum 64 characters before @)",
			});
		return c.json(
			await store.createMailbox(address, input.name, options.actor),
			201,
		);
	});
	app.use("/api/v1/mailboxes/:mailboxId", async (c, next) => {
		if (
			options.mode === "live" &&
			!(await mailboxConfig(db, c.req.param("mailboxId")))
		)
			throw new HTTPException(404);
		await next();
	});
	app.use("/api/v1/mailboxes/:mailboxId/*", async (c, next) => {
		if (
			options.mode === "live" &&
			!(await mailboxConfig(db, c.req.param("mailboxId")))
		)
			throw new HTTPException(404);
		await store.mailbox(c.req.param("mailboxId"));
		await next();
	});
	const tagActor = () => {
		if (isLive && !options.actor) throw new HTTPException(403);
		return options.actor ?? "local-synthetic-user";
	};
	for (const method of ["put", "delete"] as const) {
		app[method](
			"/api/v1/mailboxes/:mailboxId/threads/:threadId/tags/:tagId",
			async (c) => {
				await setConversationTags(
					db,
					c.req.param("mailboxId"),
					[id.parse(c.req.param("threadId"))],
					id.parse(c.req.param("tagId")),
					method === "put" ? "add" : "remove",
					tagActor(),
				);
				return c.body(null, 204);
			},
		);
	}
	app.post("/api/v1/mailboxes/:mailboxId/tags/bulk", async (c) => {
		const input = z
			.object({
				thread_ids: z.array(id).min(1).max(100),
				tag_id: id,
				action: z.enum(["add", "remove"]),
			})
			.strict()
			.parse(await c.req.json());
		await setConversationTags(
			db,
			c.req.param("mailboxId"),
			input.thread_ids,
			input.tag_id,
			input.action,
			tagActor(),
		);
		return c.body(null, 204);
	});
	app.get("/api/v1/mailboxes/:mailboxId", async (c) =>
		c.json(await store.mailbox(c.req.param("mailboxId"))),
	);
	app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
		await store.mailbox(c.req.param("mailboxId"));
		const { settings } = z
			.object({ settings: z.object({ fromName: z.string().max(120) }) })
			.parse(await c.req.json());
		const [row] = await db`UPDATE mailboxes SET settings = ${db.json(
			settings,
		)} WHERE id = ${c.req.param("mailboxId")} RETURNING *`;
		return c.json(row);
	});
	app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
		if (options.mode === "live")
			throw new HTTPException(403, {
				message: "Live mailboxes cannot be deleted",
			});
		await store.mailbox(c.req.param("mailboxId"));
		await db`DELETE FROM mailboxes WHERE id = ${c.req.param("mailboxId")}`;
		return c.body(null, 204);
	});
	for (const suffix of ["emails", "search"]) {
		app.get(`/api/v1/mailboxes/:mailboxId/${suffix}`, async (c) => {
			querySchema.parse(c.req.query());
			return c.json(await store.list(c.req.param("mailboxId"), c.req.query()));
		});
	}
	app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c) =>
		c.json(
			await store.message(
				c.req.param("mailboxId"),
				id.parse(c.req.param("id")),
			),
		),
	);
	app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c) => {
		const input = z
			.object({ read: z.boolean().optional(), starred: z.boolean().optional() })
			.strict()
			.refine((v) => Object.keys(v).length > 0)
			.parse(await c.req.json());
		const messageId = id.parse(c.req.param("id"));
		const [row] = await db<MessageRow[]>`UPDATE emails SET ${db(
			input,
		)} WHERE mailbox_id = ${c.req.param(
			"mailboxId",
		)} AND id = ${messageId} RETURNING *`;
		if (!row) throw new HTTPException(404);
		return c.json(await store.message(row.mailbox_id, row.id));
	});
	app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c) => {
		const [outbound] =
			await db`SELECT request_id FROM outbound_requests WHERE mailbox_id=${c.req.param("mailboxId")} AND email_id=${id.parse(c.req.param("id"))}`;
		if (outbound)
			throw new HTTPException(409, {
				message:
					"Sent messages retain their delivery record. Move this message to Trash instead.",
			});
		const rows = await db`DELETE FROM emails WHERE mailbox_id = ${c.req.param(
			"mailboxId",
		)} AND id = ${id.parse(c.req.param("id"))} RETURNING id`;
		if (!rows.length) throw new HTTPException(404);
		return c.body(null, 204);
	});
	app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c) => {
		const { folderId } = z
			.object({ folderId: z.string().min(1).max(100) })
			.parse(await c.req.json());
		const rows =
			await db`UPDATE emails SET folder_id = ${folderId} WHERE mailbox_id = ${c.req.param(
				"mailboxId",
			)} AND id = ${id.parse(c.req.param("id"))} RETURNING id`;
		if (!rows.length) throw new HTTPException(404);
		return c.body(null, 204);
	});
	app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c) =>
		c.json(
			await store.thread(
				c.req.param("mailboxId"),
				id.parse(c.req.param("threadId")),
			),
		),
	);
	app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c) => {
		await db`UPDATE emails SET read = true WHERE mailbox_id = ${c.req.param(
			"mailboxId",
		)} AND thread_id = ${id.parse(c.req.param("threadId"))}`;
		return c.body(null, 204);
	});
	app.get("/api/v1/mailboxes/:mailboxId/folders", async (c) =>
		c.json(await store.folders(c.req.param("mailboxId"))),
	);
	app.post("/api/v1/mailboxes/:mailboxId/folders", async (c) => {
		const { name } = z
			.object({ name: z.string().trim().min(1).max(100) })
			.parse(await c.req.json());
		const [row] =
			await db`INSERT INTO folders (mailbox_id, id, name) VALUES (${c.req.param(
				"mailboxId",
			)}, ${crypto.randomUUID()}, ${name}) RETURNING *, 0 AS "unreadCount"`;
		return c.json(row, 201);
	});
	app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c) => {
		const { name } = z
			.object({ name: z.string().trim().min(1).max(100) })
			.parse(await c.req.json());
		const [row] =
			await db`UPDATE folders SET name = ${name} WHERE mailbox_id = ${c.req.param(
				"mailboxId",
			)} AND id = ${c.req.param("id")} AND is_deletable RETURNING *`;
		if (!row)
			throw new HTTPException(409, { message: "Cannot rename this folder" });
		return c.json(row);
	});
	app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c) => {
		const rows = await db`DELETE FROM folders WHERE mailbox_id = ${c.req.param(
			"mailboxId",
		)} AND id = ${c.req.param("id")} AND is_deletable RETURNING id`;
		if (!rows.length)
			throw new HTTPException(409, { message: "Cannot delete this folder" });
		return c.body(null, 204);
	});
	app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c) => {
		const input = draftSchema.parse(await c.req.json());
		const mailbox = await store.mailbox(c.req.param("mailboxId"));
		let threadId = input.thread_id;
		if (input.in_reply_to) {
			const parent = await store.message(mailbox.id, input.in_reply_to);
			threadId = parent.thread_id ?? parent.id;
		} else if (threadId && !(await store.thread(mailbox.id, threadId)).length)
			throw new HTTPException(404);
		if (input.draft_id) {
			const [row] =
				await db`UPDATE emails SET recipient = ${input.to}, cc = ${input.cc}, bcc = ${input.bcc}, subject = ${input.subject}, body = ${input.body}, date = now()
				WHERE mailbox_id = ${mailbox.id} AND id = ${input.draft_id} AND delivery_status = 'draft' RETURNING id`;
			if (!row) throw new HTTPException(404);
			return c.json({ draft_id: row.id });
		}
		const draft = await store.insert(mailbox.id, {
			sender: mailbox.email,
			recipient: input.to,
			subject: input.subject,
			body: input.body,
			cc: input.cc,
			bcc: input.bcc,
			folder_id: "draft",
			delivery_status: "draft",
			read: true,
			thread_id: threadId,
			in_reply_to: input.in_reply_to,
		});
		return c.json({ draft_id: draft?.id }, 201);
	});
	for (const action of ["", "/:id/reply", "/:id/forward"]) {
		app.post(`/api/v1/mailboxes/:mailboxId/emails${action}`, async (c) => {
			const input = sendSchema.parse(await c.req.json());
			if (options.mode === "live") {
				if (!options.sender || !options.actor)
					throw new HTTPException(503, {
						message: "Email sending is not configured",
					});
				const key = id.parse(c.req.header("idempotency-key"));
				return c.json(
					await sendReal(
						db,
						options.sender,
						c.req.param("mailboxId"),
						key,
						input,
						options.actor,
						action ? c.req.param("id") : undefined,
						action.endsWith("reply"),
					),
					201,
				);
			}
			const mailbox = await store.mailbox(c.req.param("mailboxId"));
			const parent = action
				? await store.message(mailbox.id, id.parse(c.req.param("id")))
				: undefined;
			const reply = action.endsWith("reply");
			const message = await store.insert(mailbox.id, {
				sender: mailbox.email,
				recipient: joinRecipients(input.to),
				cc: joinRecipients(input.cc),
				bcc: joinRecipients(input.bcc),
				subject: input.subject,
				body: input.html ?? escapeHtml(input.text ?? ""),
				folder_id: "sent",
				read: true,
				delivery_status: "simulated",
				thread_id: reply ? (parent?.thread_id ?? parent?.id) : undefined,
				in_reply_to: reply ? (parent?.message_id ?? undefined) : undefined,
				email_references: reply
					? [parent?.email_references, parent?.message_id]
							.filter(Boolean)
							.join(" ")
					: undefined,
			});
			return c.json({ id: message?.id, status: "simulated" }, 201);
		});
	}
	app.get(
		"/api/v1/mailboxes/:mailboxId/emails/:id/attachments/:attachmentId",
		async (c) => {
			const [attachment] = await db<
				{ storage_key: string; filename: string }[]
			>`SELECT storage_key, filename FROM attachments
			WHERE mailbox_id = ${c.req.param("mailboxId")} AND email_id = ${id.parse(
				c.req.param("id"),
			)} AND id = ${id.parse(c.req.param("attachmentId"))}`;
			if (!attachment || !/^[a-f0-9-]{36}$/.test(attachment.storage_key))
				throw new HTTPException(404);
			const content = await options.readAttachment(attachment.storage_key);
			if (!content) throw new HTTPException(404);
			return new Response(new Uint8Array(content), {
				headers: {
					"Content-Type": "application/octet-stream",
					"X-Content-Type-Options": "nosniff",
					"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
						attachment.filename,
					)}`,
				},
			});
		},
	);
	app.route(
		"/api/v1/classification",
		classifierApi(db, {
			enabled: options.classifiersEnabled === true,
			admin:
				!isLive || (options.mailboxAdmins ?? []).includes(options.actor ?? ""),
			actor: options.actor ?? "local",
			kick: options.kickClassifiers,
		}),
	);
	if (!isLive && options.classifierPreview && options.previewRoutes)
		app.route("/api/preview", options.previewRoutes);
	app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
	return app;
}

function joinRecipients(value: string | string[] | undefined) {
	return Array.isArray(value) ? value.join(", ") : (value ?? "");
}
function escapeHtml(value: string) {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");
}
