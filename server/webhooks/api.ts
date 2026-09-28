import { Hono } from "hono";
import { z } from "zod";
import type { Database } from "../db";
import { encryptSecret, validateUrl } from "./security";
export const events = [
	"email.received",
	"email.sent",
	"conversation.tags_changed",
	"conversation.classified",
	"conversation.status_changed",
] as const;
const input = z
	.object({
		url: z.string().max(2000),
		events: z.array(z.enum(events)).min(1).max(5),
		enabled: z.boolean().default(true),
	})
	.strict();
const uuid = z.string().uuid();
export function webhookApi(
	db: Database,
	options: { canManage: boolean; secretKey?: string },
) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (!options.canManage)
			return c.json({ error: "Administrator access required" }, 403);
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.get("/:mailbox", async (c) =>
		c.json(
			await db`SELECT id,url,events,enabled,created_at FROM webhook_endpoints WHERE mailbox_id=${c.req.param("mailbox")} ORDER BY created_at DESC`,
		),
	);
	app.post("/:mailbox", async (c) => {
		if (!options.secretKey)
			return c.json(
				{ error: "Configure WEBHOOK_SECRET_KEY before adding endpoints" },
				503,
			);
		const data = input.parse(await c.req.json());
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
		const secret =
			"whsec_" +
			Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
		const [row] =
			await db`INSERT INTO webhook_endpoints(mailbox_id,url,events,enabled,secret) VALUES(${c.req.param("mailbox")},${data.url},${data.events},${data.enabled},${await encryptSecret(secret, options.secretKey)}) RETURNING id`;
		return c.json({ ...row, secret }, 201);
	});
	app.put("/:mailbox/:id", async (c) => {
		const data = input.parse(await c.req.json());
		try {
			validateUrl(data.url);
		} catch {
			return c.json({ error: "Invalid destination URL" }, 400);
		}
		const rows =
			await db`UPDATE webhook_endpoints SET url=${data.url},events=${data.events},enabled=${data.enabled} WHERE id=${uuid.parse(c.req.param("id"))} AND mailbox_id=${c.req.param("mailbox")} RETURNING id`;
		return c.json({ success: rows.length > 0 }, rows.length ? 200 : 404);
	});
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
