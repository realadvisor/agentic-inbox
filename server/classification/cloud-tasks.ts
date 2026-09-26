import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { ClassifierQueues, QueueBinding } from "./dispatch";
import { workMessage } from "./dispatch";
import { z } from "zod";

export const taskMessage = z.union([
	z
		.object({
			kind: z.literal("agent-draft"),
			version: z.literal(1),
			token: z.string().uuid(),
		})
		.strict(),
	workMessage,
]);

export const taskPath = "/internal/classification-task";
export interface CloudTasksEnv {
	CLOUD_TASKS_PROJECT?: string;
	CLOUD_TASKS_LOCATION?: string;
	CLOUD_TASKS_SERVICE_ACCOUNT?: string;
	CLOUD_TASKS_PRIVATE_KEY?: string;
	PUBLIC_ORIGIN: string;
}
const googleKeys = createRemoteJWKSet(
	new URL("https://www.googleapis.com/oauth2/v3/certs"),
);
export async function verifyTaskToken(
	token: string,
	env: CloudTasksEnv,
	keys: JWTVerifyGetKey = googleKeys,
) {
	const { payload } = await jwtVerify(token, keys, {
		issuer: ["https://accounts.google.com", "accounts.google.com"],
		audience: env.PUBLIC_ORIGIN + taskPath,
		algorithms: ["RS256"],
		requiredClaims: ["exp", "iat", "sub"],
	});
	if (
		!env.CLOUD_TASKS_SERVICE_ACCOUNT ||
		payload.email !== env.CLOUD_TASKS_SERVICE_ACCOUNT ||
		payload.email_verified !== true
	)
		throw new Error("Unexpected task identity");
}
export function cloudTasksConfigured(env: CloudTasksEnv) {
	return !!(
		env.CLOUD_TASKS_PROJECT &&
		env.CLOUD_TASKS_LOCATION &&
		env.CLOUD_TASKS_SERVICE_ACCOUNT &&
		env.CLOUD_TASKS_PRIVATE_KEY
	);
}

// Reuse short-lived OAuth tokens within a Worker isolate; never persist credentials.
const tokens = new WeakMap<
	object,
	Promise<{ value: string; expires: number }>
>();
async function accessToken(env: CloudTasksEnv, request: typeof fetch) {
	const cached = tokens.get(env);
	if (cached) {
		const token = await cached;
		if (token.expires > Date.now() + 60_000) return token.value;
	}
	const pending = (async () => {
		const key = await importPKCS8(env.CLOUD_TASKS_PRIVATE_KEY!, "RS256");
		const assertion = await new SignJWT({
			scope: "https://www.googleapis.com/auth/cloud-tasks",
		})
			.setProtectedHeader({ alg: "RS256" })
			.setIssuer(env.CLOUD_TASKS_SERVICE_ACCOUNT!)
			.setAudience("https://oauth2.googleapis.com/token")
			.setIssuedAt()
			.setExpirationTime("1h")
			.sign(key);
		const response = await request("https://oauth2.googleapis.com/token", {
			method: "POST",
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok)
			throw new Error(`Cloud Tasks OAuth HTTP ${response.status}`);
		const data = (await response.json()) as {
			access_token: string;
			expires_in: number;
		};
		if (!data.access_token || !Number.isFinite(data.expires_in))
			throw new Error("Invalid Cloud Tasks OAuth response");
		return {
			value: data.access_token,
			expires: Date.now() + data.expires_in * 1000,
		};
	})();
	tokens.set(env, pending);
	try {
		return (await pending).value;
	} catch (error) {
		tokens.delete(env);
		throw error;
	}
}

export function cloudTaskQueues(
	env: CloudTasksEnv,
	request: typeof fetch = fetch,
): ClassifierQueues & { drafts: QueueBinding } {
	if (!cloudTasksConfigured(env))
		throw new Error("Cloud Tasks is not configured");
	const binding = (queue: string, kind?: "agent-draft"): QueueBinding => ({
		async sendBatch(messages) {
			const token = await accessToken(env, request);
			// Bound publish concurrency, and settle all sends before the outbox transaction ends.
			for (let i = 0; i < messages.length; i += 10) {
				const results = await Promise.allSettled(
					messages.slice(i, i + 10).map(async (message) => {
						const response = await request(
							`https://cloudtasks.googleapis.com/v2/projects/${env.CLOUD_TASKS_PROJECT}/locations/${env.CLOUD_TASKS_LOCATION}/queues/${queue}/tasks`,
							{
								method: "POST",
								headers: {
									Authorization: `Bearer ${token}`,
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									task: {
										dispatchDeadline: "300s",
										scheduleTime: new Date(
											Date.now() + message.delaySeconds * 1000,
										).toISOString(),
										httpRequest: {
											httpMethod: "POST",
											url: env.PUBLIC_ORIGIN + taskPath,
											headers: { "Content-Type": "application/json" },
											body: btoa(
												JSON.stringify(
													kind ? { ...message.body, kind } : message.body,
												),
											),
											oidcToken: {
												serviceAccountEmail: env.CLOUD_TASKS_SERVICE_ACCOUNT,
												audience: env.PUBLIC_ORIGIN + taskPath,
											},
										},
									},
								}),
								signal: AbortSignal.timeout(10_000),
							},
						);
						if (!response.ok)
							throw new Error(`Cloud Tasks publish HTTP ${response.status}`);
					}),
				);
				const failure = results.find((result) => result.status === "rejected");
				if (failure?.status === "rejected") throw failure.reason;
			}
		},
	});
	return {
		live: binding("inbox-classifications"),
		backfill: binding("inbox-classifier-backfills"),
		drafts: binding("inbox-agent-drafts", "agent-draft"),
	};
}
