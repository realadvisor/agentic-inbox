import { Hono, type ExecutionContext } from "hono";
import { basicAuth } from "hono/basic-auth";
import postgres from "postgres";
import { createApi } from "./api";

export interface WorkerEnv {
	PUBLIC_ORIGIN: string;
	PROTOTYPE_PASSWORD: string;
	HYPERDRIVE: { connectionString: string };
	ATTACHMENTS: {
		get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	};
	ASSETS: { fetch(request: Request): Promise<Response> };
}

const worker = new Hono<{ Bindings: WorkerEnv }>();
worker.use("*", async (c, next) => {
	if (
		!c.env.PUBLIC_ORIGIN ||
		!c.env.PROTOTYPE_PASSWORD ||
		c.env.PROTOTYPE_PASSWORD.length < 24
	) {
		return c.text("Prototype access is not configured", 503);
	}
	if (new URL(c.req.url).origin !== c.env.PUBLIC_ORIGIN)
		return c.text("Unknown origin", 403);
	return basicAuth({
		username: "prototype",
		password: c.env.PROTOTYPE_PASSWORD,
		realm: "RealAdvisor Inbox Prototype",
	})(c, next);
});
worker.all("/api/*", async (c) => {
	// Connections are request-scoped; Hyperdrive owns the upstream connection pool.
	const db = postgres(c.env.HYPERDRIVE.connectionString, {
		max: 5,
		fetch_types: false,
	});
	try {
		return await createApi(db, {
			origin: c.env.PUBLIC_ORIGIN,
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
	fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
		return worker.fetch(request, env, ctx);
	},
};
