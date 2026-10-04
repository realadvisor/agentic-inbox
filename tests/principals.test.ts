import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import {
	servicePrincipal,
	serviceCanRequest,
	type Principal,
} from "../server/principals";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import worker from "../server/worker";

const healthId = "c748884d95de49bda14aa81bdd252060.access";
const mailbox = "privacy@ingest.realadvisor.com";
const other = "info@ingest.realadvisor.com";
const all = "all@ingest.realadvisor.com";
const schema = "principals_" + crypto.randomUUID().replaceAll("-", "");
const root = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const store = new InboxStore(db);
const service = (permissions: string[], mailbox_ids = [mailbox]) => {
	const principal = servicePrincipal(
		"integration.access",
		JSON.stringify({ "integration.access": { permissions, mailbox_ids } }),
	);
	assert.ok(principal?.kind === "service");
	return principal;
};
before(async () => {
	await root.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(db);
	for (const box of [mailbox, other, all]) await store.createMailbox(box, box);
});
after(async () => {
	await db.end();
	await root.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await root.end();
});

test("service grant permission matrix is explicit, mailbox scoped, and fails closed", () => {
	for (const config of [
		undefined,
		"bad-json",
		"{}",
		'{"integration.access":{}}',
		'{"integration.access":{"permissions":["admin"],"mailbox_ids":["*"]}}',
	])
		assert.equal(servicePrincipal("integration.access", config), null);
	const health = service(["health:read"], []);
	for (const [method, path] of [
		["GET", "/api/health"],
		["HEAD", "/api/health"],
		["POST", "/api/health"],
		["GET", "/"],
		["GET", "/assets/app.js"],
		["GET", "/api/docs"],
		["GET", "/api/openapi.json"],
		["GET", "/api/v1/config"],
		["GET", "/api/v1/access/members"],
		["POST", "/api/v1/operations/inbound/replay"],
		["GET", `/api/v1/mailboxes/${mailbox}/emails`],
		["POST", `/api/v1/mailboxes/${mailbox}/emails`],
		["POST", `/api/v1/mailboxes/${mailbox}/emails/id/translation`],
		["GET", "/api/health/"],
	])
		assert.equal(
			serviceCanRequest(health, method, path),
			method === "GET" && path === "/api/health",
			`${method} ${path}`,
		);
	const read = service(["mail:read"]);
	assert.equal(
		serviceCanRequest(
			read,
			"GET",
			`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/emails`,
		),
		true,
	);
	for (const [method, path] of [
		["GET", `/api/v1/mailboxes/${other}/emails`],
		["POST", `/api/v1/mailboxes/${mailbox}/emails`],
		["GET", "/api/v1/operations/inbound"],
		["GET", "/api/v1/new-route"],
		["GET", `/api/v1/mailboxes/${mailbox}%2f../emails`],
		["GET", "/api/health"],
	])
		assert.equal(serviceCanRequest(read, method, path), false, path);
	assert.equal(
		serviceCanRequest(service([], [mailbox]), "GET", "/api/v1/mailboxes"),
		false,
	);
	assert.equal(
		serviceCanRequest(service(["mail:read"], []), "GET", "/api/v1/config"),
		false,
	);
	for (const [permission, method, route] of [
		["drafts:manage", "POST", "drafts"],
		["mail:send", "POST", "emails"],
		["conversations:manage", "PUT", "threads/id/status"],
		["folders:manage", "POST", "folders"],
	]) {
		assert.equal(
			serviceCanRequest(
				service([permission]),
				method,
				`/api/v1/mailboxes/${mailbox}/${route}`,
			),
			true,
		);
		assert.equal(
			serviceCanRequest(read, method, `/api/v1/mailboxes/${mailbox}/${route}`),
			false,
		);
	}
});

test("service API preserves mailbox, sender and shared contact boundaries even with admin fallback options", async () => {
	await store.insert(all, {
		sender: "shared-secret@example.test",
		recipient: all,
		subject: "Synthetic",
		body: "private",
	});
	await store.insert(mailbox, {
		sender: "scoped-person@example.test",
		recipient: mailbox,
		subject: "Synthetic",
		body: "mail",
	});
	const api = (principal: Principal) =>
		createApi(db, {
			principal,
			actor: "service:integration.access",
			actorRole: "admin",
			mailboxAdmins: ["service:integration.access"],
			mode: "live",
			membershipEnabled: true,
			readAttachment: async () => null,
		});
	const call = (path: string, principal = service(["mail:read"])) =>
		api(principal).request(`http://127.0.0.1:4465/api/v1/${path}`);
	assert.deepEqual(
		(await (await call("mailboxes")).json()).map((m: { id: string }) => m.id),
		[mailbox],
	);
	const senders = await (await call("sender-identities")).json();
	assert.ok(
		senders.senders.every(
			(s: { mailbox_id: string }) => s.mailbox_id === mailbox,
		),
	);
	assert.deepEqual(
		await (await call(`mailboxes/${mailbox}/recipients?q=shared`)).json(),
		[],
	);
	assert.equal(
		(await (await call(`mailboxes/${mailbox}/recipients?q=scoped`)).json())
			.length,
		1,
	);
	assert.equal(
		(
			await (
				await call(
					`mailboxes/${mailbox}/recipients?q=shared`,
					service(["mail:read"], [mailbox, all]),
				)
			).json()
		).length,
		1,
	);
	for (const path of [
		`mailboxes/${other}/emails`,
		"access/members",
		"api-keys",
		"operations/inbound",
		`mailboxes/${mailbox}/agent/settings`,
	])
		assert.equal((await call(path)).status, 403, path);
});

test("Worker checks service grants before pages, membership, API and task bypass paths", async () => {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "principal",
		alg: "RS256",
		use: "sig",
	};
	const issuer = "https://principals-test.cloudflareaccess.com";
	const original = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ keys: [jwk] });
	const database = new URL(process.env.DATABASE_URL!);
	database.searchParams.set("options", `-c search_path=${schema}`);
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
		passThroughOnException() {},
		props: {},
	};
	const env = {
		PUBLIC_ORIGIN: "https://inbox.test",
		MAIL_MODE: "live" as const,
		ACCESS_MEMBERSHIP_ENABLED: "true",
		ACCESS_ISSUER: issuer,
		ACCESS_AUDIENCE: "inbox",
		MAILBOX_ADMINS: "other@realadvisor.com",
		ACCESS_SERVICE_CLIENT_IDS: healthId,
		ACCESS_SERVICE_GRANTS: JSON.stringify({
			[healthId]: { permissions: ["health:read"], mailbox_ids: [] },
		}),
		HYPERDRIVE: { connectionString: database.toString() },
		ATTACHMENTS: { get: async () => null, put: async () => undefined },
		EMAIL: {
			send: async () => {
				throw new Error("Must never send");
			},
		},
		ASSETS: { fetch: async () => new Response("page") },
	};
	const sign = (payload: Record<string, string>) =>
		new SignJWT({ type: "app", ...payload })
			.setProtectedHeader({ alg: "RS256", kid: "principal" })
			.setIssuer(issuer)
			.setAudience("inbox")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
	try {
		const token = await sign({
			common_name: healthId,
			email: "jonas@realadvisor.com",
		});
		const request = (
			path: string,
			method = "GET",
			headers: Record<string, string> = { "cf-access-jwt-assertion": token },
			config = env,
		) =>
			worker.fetch(
				new Request(`https://inbox.test${path}`, { method, headers }),
				config,
				ctx,
			);
		assert.equal((await request("/api/health")).status, 200);
		for (const membership of ["true", "false"]) {
			const config = { ...env, ACCESS_MEMBERSHIP_ENABLED: membership };
			for (const [method, path] of [
				["HEAD", "/api/health"],
				["POST", "/api/health"],
				["GET", "/"],
				["GET", "/assets/app.js"],
				["GET", "/api/docs"],
				["GET", "/api/openapi.json"],
				["GET", "/api/v1/config"],
				["GET", `/api/v1/mailboxes/${mailbox}/emails`],
				["POST", `/api/v1/mailboxes/${mailbox}/emails/id/translation`],
				["POST", "/api/v1/operations/inbound/replay"],
			])
				assert.equal(
					(await request(path, method, undefined, config)).status,
					403,
					`${membership} ${method} ${path}`,
				);
		}
		assert.equal(
			(
				await request("/api/health", "GET", undefined, {
					...env,
					ACCESS_SERVICE_GRANTS: "{}",
				})
			).status,
			403,
		);
		assert.equal(
			(
				await request("/api/v1/config", "GET", {
					Cookie: `CF_Authorization=${token}`,
				})
			).status,
			403,
		);
		assert.equal(
			(
				await request("/internal/classification-task", "POST", {
					Authorization: `Bearer ${token}`,
				})
			).status,
			401,
		);
		const human = await sign({
			email: "principal@realadvisor.com",
			sub: "person",
		});
		await db`INSERT INTO inbox_members(email,role,created_by) VALUES('principal@realadvisor.com','user','test')`;
		assert.equal(
			(await request("/", "GET", { "cf-access-jwt-assertion": human })).status,
			200,
		);
		assert.equal(
			(
				await request("/api/v1/config", "GET", {
					"cf-access-jwt-assertion": human,
				})
			).status,
			200,
		);
		await db`DELETE FROM inbox_members WHERE email='principal@realadvisor.com'`;
		assert.equal(
			(await request("/", "GET", { "cf-access-jwt-assertion": human })).status,
			403,
		);
	} finally {
		globalThis.fetch = original;
		await Promise.all(pending);
	}
});

test("service agent HTTP requests restrict nested tools and preserve service audit identity", async () => {
	const { MockLanguageModelV3 } = await import("ai/test");
	const { createTools, claimRun, stopRun } =
		await import("../server/agent/service");
	let toolNames: string[] = [];
	const pending: Promise<unknown>[] = [];
	const principal = service(["mail:read", "agent:use"]);
	const model = new MockLanguageModelV3({
		doStream: async (options) => {
			toolNames = (options.tools ?? []).map((tool) => tool.name);
			return {
				stream: new ReadableStream({
					start(controller) {
						controller.enqueue({
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: {
									total: 0,
									noCache: 0,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: { total: 0, text: 0, reasoning: 0 },
							},
						});
						controller.close();
					},
				}),
			};
		},
	});
	const api = createApi(db, {
		principal,
		mode: "live",
		membershipEnabled: true,
		readAttachment: async () => null,
		agent: {
			model: () => model,
			sources: ["workers"],
			waitUntil: (p) => pending.push(p),
		},
	});
	const runId = crypto.randomUUID();
	const response = await api.request(
		`http://127.0.0.1:4465/api/v1/mailboxes/${mailbox}/agent/chat`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: runId, prompt: "Inspect synthetic mail" }),
		},
	);
	assert.equal(response.status, 200, await response.clone().text());
	await response.text();
	await Promise.all(pending);
	assert.ok(toolNames.includes("get_email"));
	for (const denied of [
		"draft_email",
		"update_draft",
		"move_email",
		"review_classification",
		"rerun_classification",
	])
		assert.ok(!toolNames.includes(denied), denied);
	const [turn] = await db`SELECT actor FROM agent_turns WHERE id=${runId}`;
	assert.equal(turn.actor, "service:integration.access");
	const run = {
		id: crypto.randomUUID(),
		mailbox,
		actor: "service:integration.access",
		prompt: "Synthetic",
		permissions: ["mail:read", "drafts:manage"],
		mailboxIds: principal.grant.mailbox_ids,
	};
	await claimRun(db, run);
	try {
		const tools = createTools(db, run, () => {});
		assert.ok(
			"search_recipients" in tools &&
				"list_senders" in tools &&
				"draft_email" in tools,
		);
		const toolOptions = { toolCallId: "synthetic", messages: [] };
		const contacts = await tools.search_recipients.execute!(
			{ query: "shared" },
			toolOptions,
		);
		assert.ok(Array.isArray(contacts));
		assert.equal(contacts.length, 0);
		const senders = await tools.list_senders.execute!({}, toolOptions);
		assert.ok(senders && "senders" in senders);
		assert.ok(senders.senders.every((sender) => sender.mailbox_id === mailbox));
		await assert.rejects(
			() =>
				Promise.resolve(
					tools.draft_email.execute!(
						{
							to: "recipient@example.test",
							subject: "Synthetic",
							body: "Draft",
							sender_identity_id: "info@realadvisor.com",
						},
						toolOptions,
					),
				),
			/does not permit/,
		);
	} finally {
		await stopRun(db, mailbox, run.id);
	}
});

test("service send grant preserves idempotency and rejects a sender from an ungranted mailbox", async () => {
	let sent = 0;
	const api = createApi(db, {
		principal: service(["mail:send"]),
		mode: "live",
		membershipEnabled: true,
		readAttachment: async () => null,
		sender: {
			send: async () => {
				sent++;
				return { messageId: "synthetic-service-send" };
			},
		},
	});
	const requestId = crypto.randomUUID();
	const send = (sender_identity_id: string) =>
		api.request(`http://127.0.0.1:4465/api/v1/mailboxes/${mailbox}/emails`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Idempotency-Key": requestId,
			},
			body: JSON.stringify({
				to: "recipient@example.test",
				subject: "Synthetic",
				text: "Synthetic",
				sender_identity_id,
			}),
		});
	const rejected = await send("info@realadvisor.com");
	assert.equal(rejected.status, 403);
	assert.match(await rejected.text(), /does not permit/);
	assert.equal(sent, 0);
	const response = await send("privacy@realadvisor.com");
	assert.equal(response.status, 201, await response.clone().text());
	assert.equal((await send("privacy@realadvisor.com")).status, 201);
	assert.equal(sent, 1);
	const [record] =
		await db`SELECT actor FROM outbound_requests WHERE request_id=${requestId}`;
	assert.equal(record.actor, "service:integration.access");
});

test("checked-in health client grant authorizes readiness only", async () => {
	const { readFile } = await import("node:fs/promises");
	const config = JSON.parse(
		(
			await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")
		).replace(/,\s*([}\]])/g, "$1"),
	);
	const principal = servicePrincipal(
		healthId,
		config.vars.ACCESS_SERVICE_GRANTS,
	);
	assert.ok(principal?.kind === "service");
	assert.deepEqual(principal.grant, {
		mailbox_ids: [],
		permissions: ["health:read"],
	});
	assert.equal(serviceCanRequest(principal, "GET", "/api/health"), true);
	assert.equal(serviceCanRequest(principal, "GET", "/api/v1/config"), false);
});
