import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
import { conversationState } from "./state";
import { exampleOwner, listExamples } from "./curated-examples";
const targetSchema = z
	.object({
		group_id: z.string().uuid().optional(),
		classifier_id: z.string().uuid().optional(),
		mailbox_id: z.string().email(),
	})
	.strict()
	.refine(
		(v) => !!v.group_id !== !!v.classifier_id,
		"Choose a group or standalone classifier",
	);
const valueSchema = z
	.object({
		role: z.enum(["teach", "test"]),
		labels: z.array(z.string().max(80)).max(10),
		note: z.string().trim().max(1000).default(""),
		config: z.string().max(20000),
	})
	.strict();
export function examplesApi(db: Database, admin: boolean, actor: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (!admin)
			throw new HTTPException(403, {
				message: "Only inbox administrators can manage examples",
			});
		await next();
	});
	app.get("/", async (c) => {
		const target = targetSchema.parse(c.req.query());
		const owner = await exampleOwner(db, target);
		return c.json({
			examples: await listExamples(db, target, target.mailbox_id),
			config: owner.config,
		});
	});
	const threadSchema = z.object({
		mailbox: z.string().email(),
		thread: z.string().uuid(),
	});
	app.get("/threads/:mailbox/:thread", async (c) => {
		const { mailbox, thread } = threadSchema.parse(c.req.param());
		const rows =
			await db`SELECT id FROM jev_examples WHERE mailbox_id=${mailbox} AND thread_id=${thread}`;
		return c.json({ saved: rows.length > 0 });
	});
	app.delete("/threads/:mailbox/:thread", async (c) => {
		const { mailbox, thread } = threadSchema.parse(c.req.param());
		await db.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(7342211)`;
			await tx`DELETE FROM jev_examples WHERE mailbox_id=${mailbox} AND thread_id=${thread}`;
		});
		return c.body(null, 204);
	});
	app.post("/from-tags", async (c) => {
		const data = z
			.object({
				mailbox_id: z.string().email(),
				thread_id: z.string().uuid(),
				tag_ids: z.array(z.string().uuid()).max(100),
			})
			.strict()
			.parse(await c.req.json());
		const saved = await db.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(7342211)`;
			const [conversation] =
				await tx`SELECT generation FROM conversations WHERE mailbox_id=${data.mailbox_id} AND thread_id=${data.thread_id} FOR UPDATE`;
			if (!conversation)
				throw new HTTPException(404, { message: "Conversation not found" });
			const tags =
				await tx`SELECT t.id,t.name,t.group_id,c.id AS classifier_id FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id LEFT JOIN classifiers c ON c.tag_id=t.id WHERE ct.mailbox_id=${data.mailbox_id} AND ct.thread_id=${data.thread_id} AND ct.removed_at IS NULL AND t.archived_at IS NULL ORDER BY t.id`;
			if (
				JSON.stringify(tags.map((t) => t.id).sort()) !==
				JSON.stringify([...new Set(data.tag_ids)].sort())
			)
				throw new HTTPException(409, {
					message:
						"The conversation tags changed. Refresh them and save again.",
				});
			const targets = new Map<
				string,
				{
					group_id?: string;
					classifier_id?: string;
					name: string;
					labels: string[];
				}
			>();
			for (const tag of tags) {
				if (tag.group_id) {
					const key = "group:" + tag.group_id;
					const entry = targets.get(key) ?? {
						group_id: tag.group_id,
						name: "",
						labels: [] as string[],
					};
					entry.labels.push(tag.id);
					targets.set(key, entry);
				} else if (tag.classifier_id) {
					targets.set("tag:" + tag.classifier_id, {
						classifier_id: tag.classifier_id,
						name: tag.name,
						labels: ["yes"],
					});
				}
			}
			if (!targets.size)
				throw new HTTPException(400, {
					message:
						"Add a group tag or a tag configured for Jev, then save it as an example.",
				});
			const [size] =
				await tx`SELECT count(*)::int AS count,coalesce(sum(length(body)+length(subject)),0)::int AS chars FROM emails WHERE mailbox_id=${data.mailbox_id} AND thread_id=${data.thread_id} AND delivery_status IN ('received','sent')`;
			if (!size.count)
				throw new HTTPException(400, {
					message: "Examples need received or sent messages.",
				});
			if (size.count > 1000 || size.chars > 10_000_000)
				throw new HTTPException(400, {
					message: "This conversation is too large for an example.",
				});
			const conn = tx as unknown as Database;
			const state = await conversationState(
				conn,
				data.mailbox_id,
				data.thread_id,
			);
			if (new TextEncoder().encode(JSON.stringify(state)).length > 22000)
				throw new HTTPException(400, {
					message: "This conversation is too large for an example.",
				});
			const names: string[] = [];
			for (const target of targets.values()) {
				const owner = await exampleOwner(conn, target);
				if (owner.group?.selection === "single" && target.labels.length !== 1)
					throw new HTTPException(409, {
						message:
							"Choose one tag in each single-selection group before saving.",
					});
				const examples = await listExamples(conn, target, data.mailbox_id);
				const old = examples.find((e) => e.thread_id === data.thread_id);
				if (!old && examples.length >= 50)
					throw new HTTPException(400, {
						message:
							"This example set already has 50 conversations. Remove one in Settings → Tags first.",
					});
				await tx`INSERT INTO jev_examples(id,group_id,classifier_id,mailbox_id,thread_id,role,labels,note,state,config,actor) VALUES(${old?.id ?? crypto.randomUUID()},${target.group_id ?? null},${target.classifier_id ?? null},${data.mailbox_id},${data.thread_id},${old?.role ?? "teach"},${tx.json(target.labels.sort())},'',${tx.json(state)},${owner.config},${actor}) ON CONFLICT(id) DO UPDATE SET labels=excluded.labels,note='',state=excluded.state,config=excluded.config,actor=excluded.actor,updated_at=now()`;
				names.push(owner.group?.name ?? target.name);
			}
			return names;
		});
		return c.json({ saved });
	});

	async function save(body: unknown, id: string) {
		const input = z
			.object({
				target: targetSchema,
				thread_id: z.string().uuid(),
				value: valueSchema,
			})
			.strict()
			.parse(body);
		return db.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(7342211)`;
			const conn = tx as unknown as Database;
			const owner = await exampleOwner(conn, input.target);
			if (input.value.config !== owner.config)
				throw new HTTPException(409, {
					message: "Save your configuration before labeling examples.",
				});
			const labels = [...new Set(input.value.labels)].sort();
			const allowed = owner.group
				? owner.group.tags.map((t) => t.id)
				: ["yes", "no"];
			if (owner.group?.selection === "single")
				allowed.push("insufficient_evidence");
			if (
				labels.some((l) => !allowed.includes(l)) ||
				((!owner.group || owner.group.selection === "single") &&
					labels.length !== 1)
			)
				throw new HTTPException(400, {
					message: "Select the expected label for this configuration.",
				});
			const rows = await listExamples(
				conn,
				input.target,
				input.target.mailbox_id,
			);
			const old = rows.find((e) => e.id === id);
			if (!old || old.thread_id !== input.thread_id)
				throw new HTTPException(404);

			const [saved] =
				await tx`UPDATE jev_examples SET role=${input.value.role},labels=${tx.json(labels)},note=${input.value.note},config=${owner.config},actor=${actor},updated_at=now() WHERE id=${id} RETURNING *`;
			if (!saved) throw new HTTPException(404);

			return saved;
		});
	}
	app.put("/:id", async (c) =>
		c.json(
			await save(
				await c.req.json(),
				z.string().uuid().parse(c.req.param("id")),
			),
		),
	);
	app.delete("/:id", async (c) => {
		const target = targetSchema.parse(c.req.query());
		await exampleOwner(db, target);
		const rows =
			await db`DELETE FROM jev_examples WHERE id=${z.string().uuid().parse(c.req.param("id"))} AND mailbox_id=${target.mailbox_id} AND ${target.group_id ? db`group_id=${target.group_id}` : db`classifier_id=${target.classifier_id!}`} RETURNING id`;
		if (!rows.length) throw new HTTPException(404);
		return c.body(null, 204);
	});
	return app;
}
