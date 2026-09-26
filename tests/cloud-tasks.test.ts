import { test } from "node:test";
import assert from "node:assert/strict";
import {
	createLocalJWKSet,
	exportJWK,
	exportPKCS8,
	generateKeyPair,
	SignJWT,
	jwtVerify,
} from "jose";
import {
	cloudTaskQueues,
	taskPath,
	taskMessage,
	verifyTaskToken,
} from "../server/classification/cloud-tasks";

const pair = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(pair.privateKey);
const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test" };
const keys = createLocalJWKSet({ keys: [jwk] });
const config = {
	PUBLIC_ORIGIN: "https://inbox.example.test",
	CLOUD_TASKS_PROJECT: "test-project",
	CLOUD_TASKS_LOCATION: "europe-west1",
	CLOUD_TASKS_SERVICE_ACCOUNT: "inbox@test-project.iam.gserviceaccount.com",
	CLOUD_TASKS_PRIVATE_KEY: privateKey,
};

test("delivery requires signed Google identity, exact audience and expected account", async () => {
	const token = (
		claims = {},
		audience = config.PUBLIC_ORIGIN + taskPath,
		issuer = "https://accounts.google.com",
		expiration = "1h",
	) =>
		new SignJWT({
			email: config.CLOUD_TASKS_SERVICE_ACCOUNT,
			email_verified: true,
			...claims,
		})
			.setProtectedHeader({ alg: "RS256", kid: "test" })
			.setSubject("123")
			.setIssuer(issuer)
			.setAudience(audience)
			.setIssuedAt()
			.setExpirationTime(expiration)
			.sign(pair.privateKey);
	await verifyTaskToken(await token(), config, keys);
	for (const invalid of [
		await token({ email: "other@test-project.iam.gserviceaccount.com" }),
		await token({ email_verified: false }),
		await token({}, "other-audience"),
		await token({}, undefined, "https://attacker.test"),
		await token({}, undefined, undefined, "-1h"),
		"unsigned",
	])
		await assert.rejects(verifyTaskToken(invalid, config, keys));
});

test("publisher uses OAuth, separate queues, scheduled token-only envelopes and cached credentials", async () => {
	const env = { ...config };
	let oauthCalls = 0;
	const tasks: { url: string; task: any }[] = [];
	const request: typeof fetch = async (url, init) => {
		if (String(url).includes("oauth2.googleapis.com")) {
			oauthCalls++;
			const assertion = (init!.body as URLSearchParams).get("assertion")!;
			const { payload } = await jwtVerify(assertion, pair.publicKey, {
				issuer: env.CLOUD_TASKS_SERVICE_ACCOUNT,
				audience: "https://oauth2.googleapis.com/token",
			});
			assert.equal(
				payload.scope,
				"https://www.googleapis.com/auth/cloud-tasks",
			);
			return Response.json({ access_token: "test-access", expires_in: 3600 });
		}
		assert.equal(
			new Headers(init!.headers).get("Authorization"),
			"Bearer test-access",
		);
		tasks.push({
			url: String(url),
			task: JSON.parse(init!.body as string).task,
		});
		return Response.json({ name: "created" });
	};
	const queues = cloudTaskQueues(env, request);
	const body = {
		version: 2 as const,
		tokens: [crypto.randomUUID(), crypto.randomUUID()],
	};
	const message = { body, contentType: "json" as const, delaySeconds: 60 };
	const before = Date.now();
	await queues.live.sendBatch([message]);
	await queues.backfill.sendBatch([message]);
	assert.equal(oauthCalls, 1);
	assert.match(tasks[0].url, /queues\/inbox-classifications\/tasks$/);
	assert.match(tasks[1].url, /queues\/inbox-classifier-backfills\/tasks$/);
	for (const { task } of tasks) {
		assert.deepEqual(JSON.parse(atob(task.httpRequest.body)), body);
		assert.equal(task.httpRequest.url, env.PUBLIC_ORIGIN + taskPath);
		assert.equal(
			task.httpRequest.oidcToken.serviceAccountEmail,
			env.CLOUD_TASKS_SERVICE_ACCOUNT,
		);
		assert.equal(task.httpRequest.oidcToken.audience, task.httpRequest.url);
		assert.ok(Date.parse(task.scheduleTime) >= before + 60_000);
	}
});

test("partial publishing failure waits for all sends and rejects so outbox remains recoverable", async () => {
	let settled = 0;
	const queues = cloudTaskQueues({ ...config }, async (url) => {
		if (String(url).includes("oauth2.googleapis.com"))
			return Response.json({ access_token: "test", expires_in: 3600 });
		const index = settled++;
		if (!index)
			return new Response("secret error body must not escape", { status: 429 });
		await new Promise((resolve) => setTimeout(resolve, 20));
		settled++;
		return Response.json({});
	});
	const m = {
		body: { version: 1 as const, token: crypto.randomUUID() },
		contentType: "json" as const,
		delaySeconds: 0,
	};
	await assert.rejects(queues.live.sendBatch([m, m]), {
		message: "Cloud Tasks publish HTTP 429",
	});
	assert.equal(settled, 3);
});

test("OAuth failures can recover on the next publication", async () => {
	let attempts = 0;
	const queues = cloudTaskQueues({ ...config }, async (url) => {
		if (String(url).includes("oauth2.googleapis.com")) {
			if (++attempts === 1) return new Response("private", { status: 503 });
			return Response.json({ access_token: "test", expires_in: 3600 });
		}
		return Response.json({});
	});
	const messages = [
		{
			body: { version: 1 as const, token: crypto.randomUUID() },
			contentType: "json" as const,
			delaySeconds: 0,
		},
	];
	await assert.rejects(queues.live.sendBatch(messages), /OAuth HTTP 503/);
	await queues.live.sendBatch(messages);
	assert.equal(attempts, 2);
});

test("draft jobs use their own queue and an explicit token-only routing envelope", async () => {
	let delivered: any;
	const queues = cloudTaskQueues({ ...config }, async (url, init) => {
		if (String(url).includes("oauth2.googleapis.com"))
			return Response.json({ access_token: "test", expires_in: 3600 });
		assert.match(String(url), /queues\/inbox-agent-drafts\/tasks$/);
		delivered = JSON.parse(init!.body as string).task;
		return Response.json({});
	});
	const token = crypto.randomUUID();
	await queues.drafts.sendBatch([
		{
			body: { version: 1, token },
			contentType: "json",
			delaySeconds: 0,
		},
	]);
	assert.deepEqual(JSON.parse(atob(delivered.httpRequest.body)), {
		kind: "agent-draft",
		version: 1,
		token,
	});
	assert.equal(delivered.httpRequest.url, config.PUBLIC_ORIGIN + taskPath);
	assert.equal(
		delivered.httpRequest.oidcToken.audience,
		config.PUBLIC_ORIGIN + taskPath,
	);
});

test("task routing rejects unknown job kinds and malformed draft envelopes", () => {
	const token = crypto.randomUUID();
	assert.ok(
		taskMessage.safeParse({ kind: "agent-draft", version: 1, token }).success,
	);
	assert.ok(taskMessage.safeParse({ version: 1, token }).success);
	for (const envelope of [
		{ kind: "unknown", version: 1, token },
		{ kind: "agent-draft", version: 2, tokens: [token] },
		{ kind: "agent-draft", version: 1, token: "invalid" },
	])
		assert.equal(taskMessage.safeParse(envelope).success, false);
});
