import { pruneProviderRuns } from "./classification/provider-runs";
import { type AiBinding } from "./agent/service";
import { agentProviders } from "./agent/providers";
import { AGENT_QUEUE, publishAgentJobs, consumeAgentJobs } from "./agent/queue";
import {
	publishOutbox,
	parkBatch,
	consumeBatch,
	type QueueBinding,
	type QueueBatch,
} from "./classification/dispatch";
import { documentation } from "./docs";
import { Hono, type ExecutionContext } from "hono";
import { basicAuth } from "hono/basic-auth";
import postgres from "postgres";
import { createApi } from "./api";
import { verifyAccess } from "./access";
import { ingest, type InboundMessage, type ObjectStore } from "./inbound";
import type { MailSender } from "./outbound";

export interface WorkerEnv {
	AI?: AiBinding;
	AI_GATEWAY_API_KEY?: string;
	AGENT_JOBS?: QueueBinding;
	PUBLIC_ORIGIN: string;
	CLASSIFIERS_ENABLED?: string;
	CLASSIFIER_LOG_RETENTION_DAYS?: string;
	CLASSIFICATIONS?: QueueBinding;
	CLASSIFIER_BACKFILLS?: QueueBinding;
	TYPESAFE_API_KEY?: string;
	PROTOTYPE_PASSWORD?: string;
	MAIL_MODE?: "live" | "synthetic";
	ACCESS_ISSUER?: string;
	ACCESS_AUDIENCE?: string;
	INBOUND_ENABLED?: string;
	MAILBOX_ADMINS?: string;
	MAILBOX_CREATION_ENABLED?: string;
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
	const agentTasks: Promise<unknown>[] = [];
	try {
		const response = await createApi(db, {
			jevKey: c.env.TYPESAFE_API_KEY,
			origin: c.env.PUBLIC_ORIGIN,
			agent: {
				...agentProviders(c.env.AI, c.env.AI_GATEWAY_API_KEY),
				autoDraftAvailable: !!c.env.AGENT_JOBS,
				disconnectSignal: c.req.raw.signal,
				waitUntil: (task) => {
					agentTasks.push(task);
					c.executionCtx.waitUntil(task);
				},
			},
			classifiersEnabled: queuesEnabled(c.env),

			mode: c.env.MAIL_MODE ?? "synthetic",
			sender: c.env.EMAIL,
			actor: c.get("actor"),
			mailboxAdmins: (c.env.MAILBOX_ADMINS ?? "")
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean),
			mailboxCreationEnabled:
				c.env.MAILBOX_CREATION_ENABLED === "true" &&
				c.env.INBOUND_ENABLED === "true",
			readAttachment: async (key) => {
				const object = await c.env.ATTACHMENTS.get(key);
				return object ? new Uint8Array(await object.arrayBuffer()) : null;
			},
		}).fetch(c.req.raw);
		if (response.ok && !["GET", "HEAD", "OPTIONS"].includes(c.req.method))
			c.executionCtx.waitUntil(dispatchClassifiers(c.env, 10));
		return response;
	} finally {
		c.executionCtx.waitUntil(
			Promise.allSettled(agentTasks).then(() => db.end({ timeout: 5 })),
		);
	}
});
worker.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

function queuesEnabled(env: WorkerEnv) {
	return (
		env.CLASSIFIERS_ENABLED === "true" &&
		!!env.TYPESAFE_API_KEY &&
		!!env.CLASSIFICATIONS &&
		!!env.CLASSIFIER_BACKFILLS
	);
}
async function dispatchClassifiers(env: WorkerEnv, rounds = 10) {
	if (!queuesEnabled(env)) return;
	const db = postgres(env.HYPERDRIVE.connectionString, {
		max: 2,
		fetch_types: false,
	});
	try {
		for (let i = 0; i < rounds; i++) {
			if (
				(await publishOutbox(db, {
					live: env.CLASSIFICATIONS!,
					backfill: env.CLASSIFIER_BACKFILLS!,
				})) < 100
			)
				break;
		}
	} catch {
		console.error("Classifier outbox publish failed; recovery will retry");
	} finally {
		await db.end({ timeout: 5 });
	}
}

async function dispatchAgentJobs(env: WorkerEnv) {
	if ((!env.AI && !env.AI_GATEWAY_API_KEY?.trim()) || !env.AGENT_JOBS) return;
	const db = postgres(env.HYPERDRIVE.connectionString, {
		max: 2,
		fetch_types: false,
	});
	try {
		await publishAgentJobs(db, env.AGENT_JOBS);
	} finally {
		await db.end({ timeout: 5 });
	}
}

export default {
	async scheduled(_event: unknown, env: WorkerEnv) {
		// Recovery only: normal ingestion/API writes publish immediately.
		await dispatchClassifiers(env, 50);
		const db = postgres(env.HYPERDRIVE.connectionString, {
			max: 1,
			fetch_types: false,
		});
		try {
			await pruneProviderRuns(
				db,
				Number(env.CLASSIFIER_LOG_RETENTION_DAYS ?? 30),
			);
		} finally {
			await db.end({ timeout: 5 });
		}
		await dispatchAgentJobs(env);
	},
	async queue(batch: QueueBatch, env: WorkerEnv) {
		if (batch.queue === AGENT_QUEUE) {
			const provider = agentProviders(env.AI, env.AI_GATEWAY_API_KEY);
			if (!provider.model) {
				for (const message of batch.messages)
					message.retry({ delaySeconds: 300 });
				return;
			}
			const db = postgres(env.HYPERDRIVE.connectionString, {
				max: 2,
				fetch_types: false,
			});
			try {
				await consumeAgentJobs(db, batch, provider.model);
			} finally {
				await db.end({ timeout: 5 });
			}
			return;
		}
		if (!queuesEnabled(env)) {
			// Leave dispatch intent recoverable while paused; do not exhaust retries.
			const db = postgres(env.HYPERDRIVE.connectionString, {
				max: 2,
				fetch_types: false,
			});
			try {
				await parkBatch(db, batch);
			} finally {
				await db.end({ timeout: 5 });
			}
			return;
		}
		const db = postgres(env.HYPERDRIVE.connectionString, {
			max: 2,
			fetch_types: false,
		});
		try {
			await consumeBatch(db, env.TYPESAFE_API_KEY!, batch);
		} finally {
			await db.end({ timeout: 5 });
		}
		// Continue publishing large batches without waiting for the recovery cron.
		await dispatchClassifiers(env, 1);
	},
	async email(message: InboundMessage, env: WorkerEnv, ctx?: ExecutionContext) {
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
			if (ctx) {
				ctx.waitUntil(dispatchClassifiers(env, 10));
				ctx.waitUntil(dispatchAgentJobs(env));
			} else {
				await dispatchClassifiers(env, 10);
				await dispatchAgentJobs(env);
			}
		} finally {
			await db.end({ timeout: 5 });
		}
	},
	fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
		return worker.fetch(request, env, ctx);
	},
};
