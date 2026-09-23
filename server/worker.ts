import { documentation } from "./docs";
import { Hono, type ExecutionContext } from "hono";
import { basicAuth } from "hono/basic-auth";
import postgres from "postgres";
import { createApi } from "./api";
import { verifyAccess } from "./access";
import { ingest, type InboundMessage, type ObjectStore } from "./inbound";
import type { MailSender } from "./outbound";

export interface WorkerEnv {
	PUBLIC_ORIGIN: string;
	PROTOTYPE_PASSWORD?: string;
	MAIL_MODE?: "live" | "synthetic";
	ACCESS_ISSUER?: string;
	ACCESS_AUDIENCE?: string;
	INBOUND_ENABLED?: string;
	EMAIL?: MailSender;
	HYPERDRIVE: { connectionString: string };
	ATTACHMENTS: {
		get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
		put?: ObjectStore["put"];
	};
	ASSETS: { fetch(request: Request): Promise<Response> };
}

const worker = new Hono<{
	Bindings: WorkerEnv;
	Variables: { actor: string };
}>();
worker.use("*", async (c, next) => {
	if (!c.env.PUBLIC_ORIGIN) return c.text("Access is not configured", 503);
	if (new URL(c.req.url).origin !== c.env.PUBLIC_ORIGIN)
		return c.text("Unknown origin", 403);
	if (c.env.MAIL_MODE === "live") {
		if (!c.env.ACCESS_ISSUER || !c.env.ACCESS_AUDIENCE)
			return c.text("Access is not configured", 503);
		const token = c.req.header("cf-access-jwt-assertion");
		if (!token) return c.text("Cloudflare Access login required", 401);
		try {
			const identity = await verifyAccess(
				token,
				c.env.ACCESS_ISSUER,
				c.env.ACCESS_AUDIENCE,
			);
			c.set("actor", identity.email);
		} catch {
			return c.text("Invalid Access token", 401);
		}
		c.header("Cache-Control", "no-store");
		return next();
	}
	if (!c.env.PROTOTYPE_PASSWORD || c.env.PROTOTYPE_PASSWORD.length < 24)
		return c.text("Prototype access is not configured", 503);
	return basicAuth({
		username: "prototype",
		password: c.env.PROTOTYPE_PASSWORD,
		realm: "RealAdvisor Inbox Prototype",
	})(c, next);
});
worker.route("/", documentation());
worker.all("/api/*", async (c) => {
	// Connections are request-scoped; Hyperdrive owns the upstream connection pool.
	const db = postgres(c.env.HYPERDRIVE.connectionString, {
		max: 5,
		fetch_types: false,
	});
	try {
		return await createApi(db, {
			origin: c.env.PUBLIC_ORIGIN,
			mode: c.env.MAIL_MODE ?? "synthetic",
			sender: c.env.EMAIL,
			actor: c.get("actor"),
			readAttachment: async (key) => {
				const object = await c.env.ATTACHMENTS.get(key);
				return object ? new Uint8Array(await object.arrayBuffer()) : null;
			},
		}).fetch(c.req.raw);
	} finally {
		c.executionCtx.waitUntil(db.end({ timeout: 5 }));
	}
});
worker.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
	async email(message: InboundMessage, env: WorkerEnv) {
		if (
			env.MAIL_MODE !== "live" ||
			env.INBOUND_ENABLED !== "true" ||
			!env.ACCESS_ISSUER ||
			!env.ACCESS_AUDIENCE ||
			!env.ATTACHMENTS.put
		) {
			message.setReject("Inbox ingestion is not enabled");
			return;
		}
		const db = postgres(env.HYPERDRIVE.connectionString, {
			max: 2,
			fetch_types: false,
		});
		try {
			await ingest(message, db, {
				get: (key) => env.ATTACHMENTS.get(key),
				put: (key, value) => env.ATTACHMENTS.put!(key, value),
			});
		} finally {
			await db.end({ timeout: 5 });
		}
	},
	fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
		return worker.fetch(request, env, ctx);
	},
};
