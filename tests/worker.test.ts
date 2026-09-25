import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { type WorkerEnv } from "../server/worker";

const origin = "https://prototype.example.test";
const password = "synthetic-test-password-at-least-24-characters";
let assetsRead = 0;
const env: WorkerEnv = {
	PUBLIC_ORIGIN: origin,
	PROTOTYPE_PASSWORD: password,
	HYPERDRIVE: { connectionString: "postgres://unused.invalid/test" },
	ATTACHMENTS: {
		get: async () => {
			throw new Error("Unauthenticated requests must not read attachments");
		},
	},
	ASSETS: {
		fetch: async () => {
			assetsRead++;
			return new Response("Synthetic inbox");
		},
	},
};
const ctx = {
	waitUntil: (_promise: Promise<unknown>) => {},
	passThroughOnException: () => {},
	props: {},
};

test("Worker denies unconfigured deployments and anonymous UI/API/asset requests", async () => {
	assert.equal(
		(
			await worker.fetch(
				new Request(origin),
				{ ...env, PROTOTYPE_PASSWORD: "" },
				ctx,
			)
		).status,
		503,
	);
	for (const path of [
		"/",
		"/assets/app.js",
		"/api/health",
		"/api/docs",
		"/api/openapi.json",
		"/api/v1/tags",
		"/api/v1/mailboxes/test/threads/test/tags/test",
		"/api/v1/mailboxes/test/tags/bulk",
		"/vendor/scalar.js",
		"/api/v1/mailboxes",
	]) {
		const response = await worker.fetch(new Request(origin + path), env, ctx);
		assert.equal(response.status, 401);
		assert.match(response.headers.get("www-authenticate") ?? "", /^Basic/);
	}
	assert.equal(assetsRead, 0);
});

test("Worker accepts the prototype password and rejects wrong credentials/origins", async () => {
	const headers = { Authorization: `Basic ${btoa(`prototype:${password}`)}` };
	assert.equal(
		(await worker.fetch(new Request(origin, { headers }), env, ctx)).status,
		200,
	);
	assert.equal(
		(
			await worker.fetch(
				new Request("https://other.example.test", { headers }),
				env,
				ctx,
			)
		).status,
		403,
	);
	assert.equal(
		(
			await worker.fetch(
				new Request(origin, {
					headers: { Authorization: `Basic ${btoa("prototype:incorrect")}` },
				}),
				env,
				ctx,
			)
		).status,
		401,
	);
});

test("Live mode never falls back to the prototype password or unsigned identity headers", async () => {
	const live = {
		...env,
		MAIL_MODE: "live" as const,
		ACCESS_ISSUER: "https://realadvisor.cloudflareaccess.com",
		ACCESS_AUDIENCE: "test-audience",
	};
	const cases: Record<string, string>[] = [
		{ Authorization: `Basic ${btoa(`prototype:${password}`)}` },
		{ "cf-access-authenticated-user-email": "jonas@realadvisor.com" },
		{ "cf-access-jwt-assertion": "not-a-jwt" },
	];
	for (const headers of cases) {
		for (const path of [
			"/",
			"/api/docs",
			"/api/openapi.json",
			"/api/v1/tags",
			"/api/v1/mailboxes/test/threads/test/tags/test",
			"/api/v1/mailboxes/test/tags/bulk",
			"/vendor/scalar.js",
		]) {
			assert.equal(
				(await worker.fetch(new Request(origin + path, { headers }), live, ctx))
					.status,
				401,
			);
		}
	}
	assert.equal(
		(
			await worker.fetch(
				new Request(origin),
				{ ...live, ACCESS_AUDIENCE: "" },
				ctx,
			)
		).status,
		503,
	);
});

test("Cloud Tasks machine endpoint rejects unauthenticated and forged deliveries before database access", async () => {
	for (const authorization of [
		"",
		"Bearer invalid",
		`Basic ${btoa(`prototype:${password}`)}`,
	]) {
		const response = await worker.fetch(
			new Request(origin + "/internal/classification-task", {
				method: "POST",
				headers: {
					Authorization: authorization,
					"X-CloudTasks-TaskRetryCount": "100",
				},
				body: JSON.stringify({ version: 1, token: crypto.randomUUID() }),
			}),
			{
				...env,
				CLASSIFIER_TRANSPORT: "cloud-tasks",
				CLOUD_TASKS_SERVICE_ACCOUNT: "expected@example.test",
			},
			ctx,
		);
		assert.equal(response.status, 401);
	}
});
