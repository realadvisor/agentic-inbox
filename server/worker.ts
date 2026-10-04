import {
	servicePrincipal,
	serviceCanRequest,
	principalActor,
	type Principal,
} from "./principals";
import { pruneInboundRecovery } from "./operations";
import { getCookie } from "hono/cookie";
import { resolveAccessRole } from "./members";
import { deliverWebhook, publishWebhooks } from "./webhooks/delivery";
import {
	cloudTaskQueues,
	cloudTasksConfigured,
	taskPath,
	taskMessage,
	verifyTaskToken,
	type CloudTasksEnv,
} from "./classification/cloud-tasks";
import { processJob } from "./classification/queue";
import { pruneProviderRuns } from "./classification/provider-runs";
import { type AiBinding } from "./agent/service";
import { agentProviders } from "./agent/providers";
import { AGENT_QUEUE, publishAgentJobs, consumeAgentJobs } from "./agent/queue";
import {
	publishOutbox,
	consumeBatch,
	queueNames,
} from "./classification/dispatch";
import { documentation } from "./docs";
import { Hono, type ExecutionContext } from "hono";
import { basicAuth } from "hono/basic-auth";
import postgres from "postgres";
import { createApi } from "./api";
import { verifyAccess, type AccessIdentity } from "./access";
import { ingest, type InboundMessage, type ObjectStore } from "./inbound";
import type { MailSender } from "./outbound";

export interface WorkerEnv extends CloudTasksEnv {
	WEBHOOK_SECRET_KEY?: string;
	AI?: AiBinding;
	AI_GATEWAY_API_KEY?: string;
	PUBLIC_ORIGIN: string;
	CLASSIFIERS_ENABLED?: string;
	CLASSIFIER_LOG_RETENTION_DAYS?: string;
	TYPESAFE_API_KEY?: string;
	PROTOTYPE_PASSWORD?: string;
	MAIL_MODE?: "live" | "synthetic";
	ACCESS_ISSUER?: string;
	ACCESS_AUDIENCE?: string;
	INBOUND_ENABLED?: string;
	MAILBOX_ADMINS?: string;
	ACCESS_MEMBERSHIP_ENABLED?: string;
	ACCESS_SERVICE_GRANTS?: string;
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
	Variables: {
		actor: string;
		principal: Principal;
	};
}>();
// Machine endpoint authenticates Google OIDC independently of interactive Access.
worker.post(taskPath, async (c) => {
	if (new URL(c.req.url).origin !== c.env.PUBLIC_ORIGIN)
		return c.text("Unknown origin", 403);
	try {
		await verifyTaskToken(
			c.req.header("Authorization")?.replace(/^Bearer /, "") ?? "",
			c.env,
		);
	} catch {
		return c.text("Invalid task identity", 401);
	}
	const body = taskMessage.safeParse(await c.req.json().catch(() => null));
	if (!body.success) return c.text("Invalid task envelope", 400);
	const isWebhook = "kind" in body.data && body.data.kind === "webhook";
	const isDraft = "kind" in body.data && body.data.kind === "agent-draft";
	const provider = isDraft
		? agentProviders(c.env.AI, c.env.AI_GATEWAY_API_KEY)
		: undefined;
	if (
		isWebhook
			? !c.env.WEBHOOK_SECRET_KEY
			: isDraft
				? !provider?.model
				: !queuesEnabled(c.env)
	)
		return c.text("Processing is paused", 503);
	const db = postgres(c.env.HYPERDRIVE.connectionString, {
		max: 2,
		fetch_types: false,
	});
	let retry: number | undefined;
	try {
		const batch = {
			queue: isDraft ? AGENT_QUEUE : queueNames.live,
			messages: [
				{
					body:
						"kind" in body.data
							? { version: body.data.version, token: body.data.token }
							: body.data,
					ack() {},
					retry(options: { delaySeconds: number }) {
						retry = options.delaySeconds;
					},
				},
			],
		};
		if (isWebhook && "token" in body.data)
			retry = await deliverWebhook(
				db,
				body.data.token,
				c.env.WEBHOOK_SECRET_KEY!,
			);
		else if (isDraft) await consumeAgentJobs(db, batch, provider!.model!);
		else await consumeBatch(db, c.env.TYPESAFE_API_KEY!, batch, fetch, 4);
	} finally {
		await db.end({ timeout: 5 });
	}
	c.executionCtx.waitUntil(dispatchWebhooks(c.env));
	if (!isWebhook)
		c.executionCtx.waitUntil(
			isDraft ? dispatchAgentJobs(c.env) : dispatchClassifiers(c.env, 1),
		);
	if (retry !== undefined) {
		c.header("Retry-After", String(Math.max(1, retry)));
		return c.text("Retry task", 503);
	}
	return c.body(null, 204);
});
worker.use("*", async (c, next) => {
	if (!c.env.PUBLIC_ORIGIN) return c.text("Access is not configured", 503);
	if (new URL(c.req.url).origin !== c.env.PUBLIC_ORIGIN)
		return c.text("Unknown origin", 403);
	if (c.env.MAIL_MODE === "live") {
		// API credentials are verified by createApi; never accept them on pages or task routes.
		if (
			c.req.path.startsWith("/api/v1/") &&
			/^Bearer\s/i.test(c.req.header("authorization") ?? "")
		)
			return next();
		if (!c.env.ACCESS_ISSUER || !c.env.ACCESS_AUDIENCE)
			return c.text("Access is not configured", 503);
		const token =
			c.req.header("cf-access-jwt-assertion") ??
			(c.req.path.startsWith("/api/v1/")
				? getCookie(c, "CF_Authorization")
				: undefined);
		if (!token) return c.text("Cloudflare Access login required", 401);
		let identity: AccessIdentity;
		try {
			identity = await verifyAccess(
				token,
				c.env.ACCESS_ISSUER,
				c.env.ACCESS_AUDIENCE,
			);
		} catch {
			return c.text("Invalid Access token", 401);
		}
		if (identity.kind === "service") {
			const principal = servicePrincipal(
				identity.clientId,
				c.env.ACCESS_SERVICE_GRANTS,
			);
			if (
				!principal ||
				principal.kind !== "service" ||
				!serviceCanRequest(principal, c.req.method, c.req.path)
			)
				return c.text(
					"Service grant does not permit this operation or mailbox",
					403,
				);
			c.set("principal", principal);
			c.set("actor", principalActor(principal));
		} else {
			let role;
			if (c.env.ACCESS_MEMBERSHIP_ENABLED === "true") {
				const db = postgres(c.env.HYPERDRIVE.connectionString, {
					max: 2,
					fetch_types: false,
				});
				try {
					role = await resolveAccessRole(
						db,
						identity,
						(c.env.MAILBOX_ADMINS ?? "")
							.split(",")
							.map((v) => v.trim())
							.filter(Boolean),
					);
				} finally {
					await db.end({ timeout: 5 });
				}
				if (!role) return c.text("Inbox membership required", 403);
			}
			c.set("principal", {
				kind: "human",
				subject: identity.subject,
				email: identity.email,
				role: role ?? undefined,
			});
			c.set("actor", identity.email);
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
		const membershipEnabled = c.env.ACCESS_MEMBERSHIP_ENABLED === "true";
		const principal = c.get("principal");
		const actorRole = principal?.kind === "human" ? principal.role : undefined;
		const response = await createApi(db, {
			principal,
			membershipEnabled,
			readinessCheck: async () => {
				if (
					c.env.MAIL_MODE === "live" &&
					(!c.env.EMAIL ||
						!c.env.ATTACHMENTS.put ||
						!c.env.ACCESS_ISSUER ||
						!c.env.ACCESS_AUDIENCE ||
						(c.env.CLASSIFIERS_ENABLED === "true" && !queuesEnabled(c.env)))
				)
					return false;
				await c.env.ATTACHMENTS.get("health/readiness-probe");
				return true;
			},
			recoveryObjects:
				c.env.INBOUND_ENABLED === "true" && c.env.ATTACHMENTS.put
					? {
							get: (key) => c.env.ATTACHMENTS.get(key),
							put: (key, value) => c.env.ATTACHMENTS.put!(key, value),
						}
					: undefined,
			actorRole: actorRole ?? undefined,
			jevKey: c.env.TYPESAFE_API_KEY,
			kickClassifiers: (tokens = []) => {
				if (!tokens.length || !queuesEnabled(c.env)) return;
				// Own connection lifetime: the HTTP response can finish immediately.
				c.executionCtx.waitUntil(
					(async () => {
						const immediate = postgres(c.env.HYPERDRIVE.connectionString, {
							max: 5,
							fetch_types: false,
						});
						try {
							await processJob(immediate, c.env.TYPESAFE_API_KEY!, tokens[0]);
						} catch {
							console.error("Immediate reclassification deferred to queue");
						} finally {
							await immediate.end({ timeout: 5 });
						}
					})(),
				);
			},
			webhookSecretKey: c.env.WEBHOOK_SECRET_KEY,
			origin: c.env.PUBLIC_ORIGIN,
			agent: {
				...agentProviders(c.env.AI, c.env.AI_GATEWAY_API_KEY),
				autoDraftAvailable: cloudTasksConfigured(c.env),
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
		if (response.ok && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
			if (c.req.path.startsWith("/api/v1/operations/"))
				c.executionCtx.waitUntil(dispatchAgentJobs(c.env));
			c.executionCtx.waitUntil(dispatchClassifiers(c.env, 10));
			c.executionCtx.waitUntil(dispatchWebhooks(c.env));
		}
		return response;
	} catch (error) {
		if (c.req.path === "/api/health")
			return c.json({ status: "unavailable" }, 503);
		throw error;
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
		cloudTasksConfigured(env)
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
			if ((await publishOutbox(db, cloudTaskQueues(env))) < 100) break;
		}
	} catch {
		console.error("Classifier outbox publish failed; recovery will retry");
	} finally {
		await db.end({ timeout: 5 });
	}
}

async function dispatchAgentJobs(env: WorkerEnv) {
	if (
		(!env.AI && !env.AI_GATEWAY_API_KEY?.trim()) ||
		!cloudTasksConfigured(env)
	)
		return;
	const db = postgres(env.HYPERDRIVE.connectionString, {
		max: 2,
		fetch_types: false,
	});
	try {
		await publishAgentJobs(db, cloudTaskQueues(env).drafts);
	} finally {
		await db.end({ timeout: 5 });
	}
}

async function dispatchWebhooks(env: WorkerEnv) {
	if (!cloudTasksConfigured(env) || !env.WEBHOOK_SECRET_KEY) return;
	const db = postgres(env.HYPERDRIVE.connectionString, {
		max: 2,
		fetch_types: false,
	});
	try {
		await publishWebhooks(db, cloudTaskQueues(env).webhooks);
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
			await db`DELETE FROM webhook_events WHERE created_at<now()-interval '30 days' AND NOT EXISTS(SELECT 1 FROM webhook_deliveries d WHERE d.event_id=webhook_events.id AND d.status='pending')`;
			// Only completed journal metadata expires. Raw MIME remains under the existing
			// private raw-mail retention policy; unresolved recovery artifacts never expire.
			await pruneInboundRecovery(db);
			await pruneProviderRuns(
				db,
				Number(env.CLASSIFIER_LOG_RETENTION_DAYS ?? 30),
			);
		} finally {
			await db.end({ timeout: 5 });
		}
		await dispatchAgentJobs(env);
		await dispatchWebhooks(env);
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
				ctx.waitUntil(dispatchWebhooks(env));
			} else {
				await dispatchClassifiers(env, 10);
				await dispatchAgentJobs(env);
				await dispatchWebhooks(env);
			}
		} finally {
			await db.end({ timeout: 5 });
		}
	},
	fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext) {
		return worker.fetch(request, env, ctx);
	},
};
