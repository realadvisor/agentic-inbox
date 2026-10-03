import type { KeyVariables } from "../api-keys";
import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db";
import { decryptSecret, encryptSecret, validateUrl } from "./security";
export const events = [
	"email.received",
	"email.sent",
	"conversation.tags_changed",
	"conversation.classified",
	"conversation.status_changed",
	"conversation.matched",
] as const;
const input = z
	.object({
		url: z.string().max(2000),
		events: z.array(z.enum(events)).min(1).max(6),
		enabled: z.boolean().default(true),
		include_tag_ids: z.array(z.string().uuid()).max(50).optional(),
		exclude_tag_ids: z.array(z.string().uuid()).max(50).optional(),
		tag_match: z.enum(["any", "all"]).optional(),
	})
	.strict();
const uuid = z.string().uuid();
export function webhookApi(
	db: Database,
	options: { canManage: boolean; secretKey?: string },
) {
	const app = new Hono<{ Variables: KeyVariables }>();
	app.use("*", async (c, next) => {
		if (
			!options.canManage &&
			!c.get("apiKey")?.permissions.includes("webhooks:manage")
		)
			return c.json({ error: "Administrator access required" }, 403);
		const key = c.get("apiKey");
		const path = c.req.path.split("/").map(decodeURIComponent);
		if (key && path[5]) {
			const id = uuid.parse(path[5]);
			const [owned] =
				await db`SELECT 1 FROM webhook_endpoints WHERE id=${id} AND mailbox_id=${path[4]} AND api_key_id=${key.id}`;
			if (!owned) return c.json({ error: "Endpoint not found" }, 404);
		}
		c.header("Cache-Control", "no-store");
		await next();
	});
	for (const rotate of [false, true]) {
		app.post(
			rotate ? "/:mailbox/:id/secret/rotate" : "/:mailbox/:id/secret",
			async (c) => {
				if (!/^[a-f0-9]{64}$/i.test(options.secretKey ?? ""))
					return c.json(
						{
							error:
								"Configure WEBHOOK_SECRET_KEY before managing signing secrets",
						},
						503,
					);
				const id = uuid.parse(c.req.param("id"));
				const [endpoint] =
					await db`SELECT secret FROM webhook_endpoints WHERE id=${id} AND mailbox_id=${c.req.param("mailbox")}`;
				if (!endpoint) return c.json({ error: "Endpoint not found" }, 404);
				const secret = rotate
					? "whsec_" +
						Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
							"hex",
						)
					: await decryptSecret(endpoint.secret, options.secretKey!);
				if (rotate) {
					const encrypted = await encryptSecret(secret, options.secretKey!);
					const updated =
						await db`UPDATE webhook_endpoints SET secret=${encrypted} WHERE id=${id} AND mailbox_id=${c.req.param("mailbox")} RETURNING id`;
					if (!updated.length)
						return c.json({ error: "Endpoint not found" }, 404);
				}
				return c.json({ id, secret });
			},
		);
	}

	app.get("/:mailbox", async (c) =>
		c.json(
			await db`SELECT id,url,to_json(events) AS events,enabled,to_json(include_tag_ids) AS include_tag_ids,to_json(exclude_tag_ids) AS exclude_tag_ids,tag_match,created_at FROM webhook_endpoints WHERE mailbox_id=${c.req.param("mailbox")} AND (${c.get("apiKey")?.id ?? null}::uuid IS NULL OR api_key_id=${c.get("apiKey")?.id ?? null}) ORDER BY created_at DESC`,
		),
	);
	for (const method of ["post", "put"] as const) {
		app[method](
			method === "post" ? "/:mailbox" : "/:mailbox/:id",
			async (c) => {
				if (
					method === "post" &&
					!/^[a-f0-9]{64}$/i.test(options.secretKey ?? "")
				)
					return c.json(
						{ error: "Configure WEBHOOK_SECRET_KEY before adding endpoints" },
						503,
					);
				const parsed = input.safeParse(await c.req.json());
				if (!parsed.success)
					return c.json({ error: parsed.error.issues[0].message }, 400);
				const data = parsed.data;
				try {
					validateUrl(data.url);
				} catch {
					return c.json(
						{
							error:
								"Use a public HTTPS hostname without credentials or a custom port",
						},
						400,
					);
				}
				const mailbox = c.req.param("mailbox");
				const endpointId =
					method === "post"
						? crypto.randomUUID()
						: uuid.parse(c.req.param("id"));
				const secret =
					method === "post"
						? "whsec_" +
							Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
								"hex",
							)
						: undefined;
				const encrypted = secret
					? await encryptSecret(secret, options.secretKey!)
					: null;
				const result = await db.begin(async (tx) => {
					const [existing] =
						await tx`SELECT *,to_json(events) AS events,to_json(include_tag_ids) AS include_tag_ids,to_json(exclude_tag_ids) AS exclude_tag_ids FROM webhook_endpoints WHERE id=${endpointId} AND mailbox_id=${mailbox} FOR UPDATE`;
					if (method === "put" && !existing)
						return { error: "Endpoint not found", status: 404 as const };
					const included = [
						...new Set(data.include_tag_ids ?? existing?.include_tag_ids ?? []),
					] as string[];
					const excluded = [
						...new Set(data.exclude_tag_ids ?? existing?.exclude_tag_ids ?? []),
					] as string[];
					const mode = data.tag_match ?? existing?.tag_match ?? "any";
					if (included.some((id) => excluded.includes(id)))
						return {
							error: "A tag cannot be both included and excluded",
							status: 400 as const,
						};
					if (
						data.events.includes("conversation.matched") &&
						!included.length &&
						!excluded.length
					)
						return {
							error:
								"Choose at least one tag for a starts-matching subscription",
							status: 400 as const,
						};
					// Existing archived filters must remain editable/disableable; only
					// newly selected IDs need to be active.
					const retained = new Set<string>([
						...(existing?.include_tag_ids ?? []),
						...(existing?.exclude_tag_ids ?? []),
					]);
					const ids = [...included, ...excluded].filter(
						(id) => !retained.has(id),
					);
					if (ids.length) {
						const tags =
							await tx`SELECT id FROM tags WHERE id IN ${tx(ids)} AND archived_at IS NULL`;
						if (tags.length !== ids.length)
							return {
								error: "Choose existing, active tags",
								status: 400 as const,
							};
					}
					if (method === "post") {
						const [box] =
							await tx`SELECT id FROM mailboxes WHERE id=${mailbox}`;
						if (!box)
							return { error: "Mailbox not found", status: 404 as const };
						await tx`INSERT INTO webhook_endpoints(id,mailbox_id,url,events,enabled,secret,include_tag_ids,exclude_tag_ids,tag_match,api_key_id)
					 VALUES(${endpointId},${mailbox},${data.url},ARRAY(SELECT jsonb_array_elements_text(${tx.json(data.events)}::jsonb)),${data.enabled},${encrypted!},ARRAY(SELECT jsonb_array_elements_text(${tx.json(included)}::jsonb)::uuid),ARRAY(SELECT jsonb_array_elements_text(${tx.json(excluded)}::jsonb)::uuid),${mode},${c.get("apiKey")?.id ?? null})`;
					} else {
						await tx`UPDATE webhook_endpoints SET url=${data.url},events=ARRAY(SELECT jsonb_array_elements_text(${tx.json(data.events)}::jsonb)),enabled=${data.enabled},include_tag_ids=ARRAY(SELECT jsonb_array_elements_text(${tx.json(included)}::jsonb)::uuid),exclude_tag_ids=ARRAY(SELECT jsonb_array_elements_text(${tx.json(excluded)}::jsonb)::uuid),tag_match=${mode} WHERE id=${endpointId}`;
					}
					// Establish a baseline without sending existing conversations. Run on filter
					// changes/re-enable only; URL edits must not reset transition tracking.
					const reset =
						!existing ||
						(!existing.enabled && data.enabled) ||
						JSON.stringify(existing.include_tag_ids) !==
							JSON.stringify(included) ||
						JSON.stringify(existing.exclude_tag_ids) !==
							JSON.stringify(excluded) ||
						existing.tag_match !== mode ||
						(!existing.events.includes("conversation.matched") &&
							data.events.includes("conversation.matched"));
					if (reset) {
						await tx`DELETE FROM webhook_matches WHERE endpoint_id=${endpointId}`;
						if (data.events.includes("conversation.matched"))
							await tx`INSERT INTO webhook_matches(endpoint_id,thread_id,matched)
						 SELECT ${endpointId},thread_id,true FROM conversations WHERE mailbox_id=${mailbox}
						 AND webhook_tags_match(webhook_thread_tags(mailbox_id,thread_id),ARRAY(SELECT jsonb_array_elements_text(${tx.json(included)}::jsonb)::uuid)::uuid[],ARRAY(SELECT jsonb_array_elements_text(${tx.json(excluded)}::jsonb)::uuid)::uuid[],${mode})`;
					}
					return { id: endpointId };
				});
				if ("error" in result)
					return c.json({ error: result.error }, result.status!);
				return c.json(
					secret ? { id: endpointId, secret } : { success: true },
					method === "post" ? 201 : 200,
				);
			},
		);
	}
	app.delete("/:mailbox/:id", async (c) => {
		await db`DELETE FROM webhook_endpoints WHERE id=${uuid.parse(c.req.param("id"))} AND mailbox_id=${c.req.param("mailbox")}`;
		return c.json({ success: true });
	});
	app.get("/:mailbox/:id/deliveries", async (c) =>
		c.json(
			await db`SELECT d.id,d.status,d.attempts,d.created_at,v.type,v.payload,COALESCE((SELECT jsonb_agg(a ORDER BY a.created_at DESC) FROM webhook_attempts a WHERE a.delivery_id=d.id),'[]'::jsonb) AS history FROM webhook_deliveries d JOIN webhook_events v ON v.id=d.event_id JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE e.id=${uuid.parse(c.req.param("id"))} AND e.mailbox_id=${c.req.param("mailbox")} ORDER BY d.created_at DESC LIMIT 50`,
		),
	);
	app.post("/:mailbox/:id/test", async (c) => {
		const result = await db.begin(async (tx) => {
			const [e] =
				await tx`SELECT id FROM webhook_endpoints WHERE id=${uuid.parse(c.req.param("id"))} AND mailbox_id=${c.req.param("mailbox")} AND enabled FOR SHARE`;
			if (!e) return null;
			const id = crypto.randomUUID();
			const payload = {
				id,
				type: "test.ping",
				timestamp: new Date().toISOString(),
				mailbox_id: c.req.param("mailbox"),
				data: { message: "Inbox webhook test" },
			};
			await tx`INSERT INTO webhook_events(id,mailbox_id,type,payload) VALUES(${id},${c.req.param("mailbox")},'test.ping',${tx.json(payload)})`;
			const [d] =
				await tx`INSERT INTO webhook_deliveries(event_id,endpoint_id) VALUES(${id},${e.id}) RETURNING id`;
			return d;
		});
		return c.json(
			result ?? { error: "Enable this endpoint before testing" },
			result ? 202 : 400,
		);
	});
	app.post("/:mailbox/:id/deliveries/:delivery/retry", async (c) => {
		const rows =
			await db`UPDATE webhook_deliveries d SET status='pending',attempts=0,published_at=NULL,available_at=now(),lease_until=NULL,lease_id=NULL FROM webhook_endpoints e WHERE e.id=d.endpoint_id AND e.id=${uuid.parse(c.req.param("id"))} AND e.mailbox_id=${c.req.param("mailbox")} AND e.enabled AND d.id=${uuid.parse(c.req.param("delivery"))} AND d.status='failed' RETURNING d.id`;
		return c.json(
			rows[0] ?? {
				error: "Only failed deliveries on enabled endpoints can be retried",
			},
			rows.length ? 202 : 400,
		);
	});
	return app;
}
