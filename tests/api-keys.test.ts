import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import { hashApiKey, keyCanRequest } from "../server/api-keys";
const schema = "keys_" + crypto.randomUUID().replaceAll("-", "");
const root = connect(),
	db = connect(process.env.DATABASE_URL, schema),
	store = new InboxStore(db);
const mailbox = "keys@ingest.realadvisor.com",
	other = "other@ingest.realadvisor.com";
const api = (role?: "admin" | "user") =>
	createApi(db, {
		mode: "live",
		membershipEnabled: true,
		actorRole: role,
		actor: role ? "owner@realadvisor.com" : undefined,
		webhookSecretKey: "ab".repeat(32),
		readAttachment: async () => null,
	});
const call = (
	path: string,
	method = "GET",
	body?: unknown,
	key?: string,
	role?: "admin" | "user",
) =>
	api(role).request(`http://127.0.0.1:4311/api/v1/${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(key ? { Authorization: `Bearer ${key}` } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
before(async () => {
	await root.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(db);
	await store.createMailbox(mailbox, "Keys");
	await store.createMailbox(other, "Other");
});
after(async () => {
	await db.end();
	await root.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await root.end();
});
async function issue(permissions = ["mail:read"], mailbox_ids = [mailbox]) {
	const r = await call(
		"api-keys",
		"POST",
		{ name: "Test automation", permissions, mailbox_ids },
		undefined,
		"admin",
	);
	assert.equal(r.status, 201, await r.clone().text());
	return r.json() as Promise<{ id: string; key: string }>;
}
test("admin creates keys, hash-only storage, list redaction and authenticated usage tracking", async () => {
	const k = await issue();
	assert.match(k.key, /^inbox_[a-f0-9]{64}$/);
	const [stored] = await db`SELECT * FROM inbox_api_keys WHERE id=${k.id}`;
	assert.equal(stored.token_hash, await hashApiKey(k.key));
	assert.equal(JSON.stringify(stored).includes(k.key), false);
	const list = await (
		await call("api-keys", "GET", undefined, undefined, "admin")
	).json();
	assert.equal(JSON.stringify(list).includes(stored.token_hash), false);
	assert.equal(JSON.stringify(list).includes(k.key), false);
	assert.equal(
		(await call("mailboxes/" + mailbox + "/emails", "GET", undefined, k.key))
			.status,
		200,
	);
	const [usage] =
		await db`SELECT request_count,last_used_at FROM inbox_api_keys WHERE id=${k.id}`;
	assert.equal(Number(usage.request_count), 1);
	assert.ok(usage.last_used_at);
});
test("keys cannot read another mailbox, mutate mail, access agent/admin routes, or delegate keys", async () => {
	const { key } = await issue();
	for (const [path, method] of [
		[`mailboxes/${other}/emails`, "GET"],
		[`mailboxes/${other}/threads/${crypto.randomUUID()}`, "GET"],
		[`mailboxes/${mailbox}/drafts`, "POST"],
		[`mailboxes/${mailbox}/emails/send`, "POST"],
		[`mailboxes/${mailbox}/agent/settings`, "GET"],
		["api-keys", "GET"],
		["api-keys", "POST"],
		["access/members", "GET"],
		["tags", "POST"],
		["classification/runs", "GET"],
		[`webhooks/${mailbox}`, "GET"],
	])
		assert.equal(
			(await call(path, method, method === "POST" ? {} : undefined, key))
				.status,
			403,
			path,
		);
});
test("missing, invalid, expired and revoked keys fail closed, including with admin session", async () => {
	assert.equal((await call("config")).status, 403);
	assert.equal(
		(await call("config", "GET", undefined, "inbox_" + "0".repeat(64), "admin"))
			.status,
		401,
	);
	const k = await issue();
	await db`UPDATE inbox_api_keys SET expires_at=now()-interval '1 second' WHERE id=${k.id}`;
	assert.equal((await call("config", "GET", undefined, k.key)).status, 401);
	const valid = await issue();
	assert.equal(
		(
			await call(
				`api-keys/${valid.id}`,
				"DELETE",
				undefined,
				undefined,
				"admin",
			)
		).status,
		204,
	);
	assert.equal((await call("config", "GET", undefined, valid.key)).status, 401);
});
test("normal users cannot list/create/revoke keys and input is bounded", async () => {
	for (const method of ["GET", "POST", "DELETE"])
		assert.equal(
			(
				await call(
					method === "DELETE" ? `api-keys/${crypto.randomUUID()}` : "api-keys",
					method,
					method === "POST" ? {} : undefined,
					undefined,
					"user",
				)
			).status,
			403,
		);
	for (const patch of [
		{ permissions: ["admin"] },
		{ mailbox_ids: [] },
		{ mailbox_ids: ["missing@example.test"] },
		{ expires_at: "2020-01-01T00:00:00Z" },
	])
		assert.equal(
			(
				await call(
					"api-keys",
					"POST",
					{
						name: "x",
						permissions: ["mail:read"],
						mailbox_ids: [mailbox],
						...patch,
					},
					undefined,
					"admin",
				)
			).status,
			400,
		);
});
test("mailbox list is scoped and configuration never claims administrator access", async () => {
	const { key } = await issue();
	// Synthetic mode allows test-domain mailbox listing but must still enforce key scope.
	const local = createApi(db, { readAttachment: async () => null });
	const list = await (
		await local.request("http://127.0.0.1:4311/api/v1/mailboxes", {
			headers: { Authorization: `Bearer ${key}` },
		})
	).json();
	assert.deepEqual(
		list.map((m: { id: string }) => m.id),
		[mailbox],
	);
	const config = await (await call("config", "GET", undefined, key)).json();
	assert.equal(config.access.role, "integration");
	assert.equal(config.canManageWebhooks, false);
});
test("webhook keys manage only their own endpoints; administrators retain control", async () => {
	const a = await issue(["webhooks:manage"]),
		b = await issue(["webhooks:manage"]);
	const body = {
		url: "https://hooks.example.com/inbox",
		events: ["conversation.classified"],
	};
	const created = await call(`webhooks/${mailbox}`, "POST", body, a.key);
	assert.equal(created.status, 201, await created.clone().text());
	const endpoint = await created.json();
	assert.ok(endpoint.secret);
	const [row] =
		await db`SELECT api_key_id FROM webhook_endpoints WHERE id=${endpoint.id}`;
	assert.equal(row.api_key_id, a.id);
	assert.equal(
		(await call(`webhooks/${mailbox}/${endpoint.id}`, "PUT", body, a.key))
			.status,
		200,
	);
	assert.equal(
		(await call(`webhooks/${mailbox}/${endpoint.id}/test`, "POST", {}, a.key))
			.status,
		202,
	);
	for (const [suffix, method] of [
		["", "PUT"],
		["", "DELETE"],
		["/test", "POST"],
		["/deliveries", "GET"],
		[`/deliveries/${crypto.randomUUID()}/retry`, "POST"],
	])
		assert.equal(
			(
				await call(
					`webhooks/${mailbox}/${endpoint.id}${suffix}`,
					method,
					["POST", "PUT"].includes(method) ? body : undefined,
					b.key,
				)
			).status,
			404,
		);
	assert.deepEqual(
		await (await call(`webhooks/${mailbox}`, "GET", undefined, b.key)).json(),
		[],
	);
	assert.equal(
		(await call(`webhooks/${other}`, "POST", body, a.key)).status,
		403,
	);
	assert.equal(
		(await call(`mailboxes/${mailbox}/emails`, "GET", undefined, a.key)).status,
		403,
	);
	assert.equal(
		(
			await call(
				`webhooks/${mailbox}/${endpoint.id}`,
				"DELETE",
				undefined,
				undefined,
				"admin",
			)
		).status,
		200,
	);
});
test("path allowlist denies encoded separators and future routes", () => {
	const key = {
		id: crypto.randomUUID(),
		permissions: ["mail:read"],
		mailbox_ids: [mailbox],
	};
	for (const path of [
		`/api/v1/mailboxes/${mailbox}/agent`,
		`/api/v1/mailboxes/${mailbox}%2Femails`,
		`/api/v1/mailboxes/${mailbox}/emails%2Ffake`,
		`/api/v1/api-keys`,
		`/api/v1/mailboxes/${mailbox}/emails/../settings`,
	])
		assert.equal(keyCanRequest(key, "GET", path), false, path);
});

test("Worker accepts Bearer keys without Access, rejects missing keys and confines them to the API", async () => {
	const { default: worker } = await import("../server/worker");
	const database = new URL(process.env.DATABASE_URL!);
	database.searchParams.set("options", `-c search_path=${schema}`);
	const env = {
		PUBLIC_ORIGIN: "https://inbox.test",
		MAIL_MODE: "live" as const,
		ACCESS_MEMBERSHIP_ENABLED: "true",
		ACCESS_ISSUER: "https://keys-test.cloudflareaccess.com",
		ACCESS_AUDIENCE: "inbox",
		HYPERDRIVE: { connectionString: database.toString() },
		ATTACHMENTS: { get: async () => null },
		ASSETS: { fetch: async () => new Response("page") },
	};
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (p: Promise<unknown>) => pending.push(p),
		passThroughOnException: () => {},
		props: {},
	};
	const k = await issue();
	const fetch = (path: string, headers?: Record<string, string>) =>
		worker.fetch(
			new Request(`https://inbox.test${path}`, { headers }),
			env,
			ctx,
		);
	assert.equal((await fetch("/api/v1/config")).status, 401);
	assert.equal(
		(await fetch("/api/v1/config", { Authorization: `Bearer ${k.key}` }))
			.status,
		200,
	);
	assert.equal(
		(await fetch("/api/v1/config", { Authorization: "Bearer bad" })).status,
		401,
	);
	assert.equal(
		(await fetch("/", { Authorization: `Bearer ${k.key}` })).status,
		401,
	);
	assert.equal(
		(
			await fetch("/api/v1/config", {
				"cf-access-authenticated-user-email": "owner@realadvisor.com",
			})
		).status,
		401,
	);
	await Promise.all(pending);
});

test("Worker verifies Access cookies on bypassed API paths and enforces browser origin", async () => {
	const { default: worker } = await import("../server/worker");
	const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "cookie-key",
		alg: "RS256",
		use: "sig",
	};
	const issuer = "https://cookie-keys-test.cloudflareaccess.com";
	const original = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ keys: [jwk] });
	const pending: Promise<unknown>[] = [];
	try {
		await db`INSERT INTO inbox_members(email,role,created_by) VALUES('cookie@realadvisor.com','admin','test')`;
		const token = await new SignJWT({
			type: "app",
			email: "cookie@realadvisor.com",
		})
			.setProtectedHeader({ alg: "RS256", kid: "cookie-key" })
			.setIssuer(issuer)
			.setAudience("inbox")
			.setSubject("cookie")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const database = new URL(process.env.DATABASE_URL!);
		database.searchParams.set("options", `-c search_path=${schema}`);
		const env = {
			PUBLIC_ORIGIN: "https://inbox.test",
			MAIL_MODE: "live" as const,
			ACCESS_MEMBERSHIP_ENABLED: "true",
			ACCESS_ISSUER: issuer,
			ACCESS_AUDIENCE: "inbox",
			HYPERDRIVE: { connectionString: database.toString() },
			ATTACHMENTS: { get: async () => null },
			ASSETS: { fetch: async () => new Response("page") },
		};
		const ctx = {
			waitUntil: (p: Promise<unknown>) => pending.push(p),
			passThroughOnException: () => {},
			props: {},
		};
		const fetch = (cookie: string, origin = "https://inbox.test") =>
			worker.fetch(
				new Request("https://inbox.test/api/v1/api-keys", {
					headers: { Cookie: `CF_Authorization=${cookie}`, Origin: origin },
				}),
				env,
				ctx,
			);
		assert.equal((await fetch(token)).status, 200);
		assert.equal((await fetch(token, "https://attacker.test")).status, 403);
		assert.equal((await fetch(token + "forged")).status, 401);
		await db`DELETE FROM inbox_members WHERE email='cookie@realadvisor.com'`;
		assert.equal((await fetch(token)).status, 403);
	} finally {
		globalThis.fetch = original;
		await Promise.all(pending);
	}
});

test("draft keys can edit and delete drafts but cannot send or delete received mail", async () => {
	const { key } = await issue(["drafts:manage"]);
	const path = `mailboxes/${mailbox}`;
	const created = await call(
		`${path}/drafts`,
		"POST",
		{ to: "test@example.test", subject: "Draft", body: "First" },
		key,
	);
	assert.equal(created.status, 201, await created.clone().text());
	const draft = await created.json();
	assert.equal(
		(
			await call(
				`${path}/drafts`,
				"POST",
				{
					draft_id: draft.draft_id,
					draft_version: draft.draft_version,
					body: "Updated",
				},
				key,
			)
		).status,
		200,
	);
	assert.equal(
		(
			await call(
				`${path}/emails`,
				"POST",
				{ to: "test@example.test", subject: "No", text: "No" },
				key,
			)
		).status,
		403,
	);
	const received = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Received",
		body: "Body",
		folder_id: "inbox",
	});
	assert.equal(
		(await call(`${path}/emails/${received!.id}`, "DELETE", undefined, key))
			.status,
		404,
	);
	assert.equal(
		(
			await call(
				`${path}/emails/${received!.id}/move`,
				"POST",
				{ folderId: "draft" },
				key,
			)
		).status,
		403,
	);
	assert.equal(
		(await call(`mailboxes/${other}/drafts`, "POST", { body: "No" }, key))
			.status,
		403,
	);
	assert.equal(
		(await call(`${path}/emails/${draft.draft_id}`, "DELETE", undefined, key))
			.status,
		204,
	);
});

test("send scope sends and replies with key attribution and idempotency through the live handler", async () => {
	const k = await issue(["mail:send"]);
	let sends = 0;
	const live = createApi(db, {
		mode: "live",
		membershipEnabled: true,
		readAttachment: async () => null,
		sender: {
			send: async () => {
				sends++;
				return { messageId: `test-${sends}` };
			},
		},
	});
	const send = (
		scope: string,
		box: string,
		suffix: string,
		requestId: string,
	) =>
		live.request(
			`http://127.0.0.1:4311/api/v1/mailboxes/${box}/emails${suffix}`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${scope}`,
					"idempotency-key": requestId,
				},
				body: JSON.stringify({
					to: "recipient@example.test",
					subject: "Test",
					text: "Body",
				}),
			},
		);
	const requestId = crypto.randomUUID();
	const response = await send(k.key, mailbox, "", requestId);
	assert.equal(response.status, 201, await response.clone().text());
	const sent = await response.json();
	assert.equal((await send(k.key, mailbox, "", requestId)).status, 201);
	assert.equal(sends, 1);
	for (const action of ["reply", "forward"])
		assert.equal(
			(await send(k.key, mailbox, `/${sent.id}/${action}`, crypto.randomUUID()))
				.status,
			201,
		);
	const [record] =
		await db`SELECT actor FROM outbound_requests WHERE request_id=${requestId}`;
	assert.equal(record.actor, `api-key:${k.id}`);
	const reader = await issue();
	assert.equal(
		(await send(reader.key, mailbox, "", crypto.randomUUID())).status,
		403,
	);
	assert.equal((await send(k.key, other, "", crypto.randomUUID())).status, 403);
	assert.equal(
		(await call(`mailboxes/${mailbox}/drafts`, "POST", { body: "No" }, k.key))
			.status,
		403,
	);
	const drafter = await issue(["drafts:manage", "conversations:manage"]);
	assert.equal(
		(
			await call(
				`mailboxes/${mailbox}/emails/${sent.id}/move`,
				"POST",
				{ folderId: "draft" },
				drafter.key,
			)
		).status,
		204,
	);
	assert.equal(
		(
			await call(
				`mailboxes/${mailbox}/emails/${sent.id}`,
				"DELETE",
				undefined,
				drafter.key,
			)
		).status,
		404,
	);
});

test("conversation permission changes flags, folders, tags and status without admin access", async () => {
	const k = await issue(["conversations:manage"]);
	const email = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Actions",
		body: "Body",
		folder_id: "inbox",
	});
	const [row] = await db`SELECT thread_id FROM emails WHERE id=${email!.id}`;
	const base = `mailboxes/${mailbox}`;
	assert.equal(
		(
			await call(
				`${base}/emails/${email!.id}`,
				"PUT",
				{ read: true, starred: true },
				k.key,
			)
		).status,
		200,
	);
	assert.equal(
		(
			await call(
				`${base}/emails/${email!.id}/move`,
				"POST",
				{ folderId: "archive" },
				k.key,
			)
		).status,
		204,
	);
	assert.equal(
		(
			await call(
				`${base}/threads/${row.thread_id}/read`,
				"POST",
				{ read: false },
				k.key,
			)
		).status,
		204,
	);
	const [state] =
		await db`SELECT revision FROM conversations WHERE mailbox_id=${mailbox} AND thread_id=${row.thread_id}`;
	const changed = await call(
		`${base}/threads/${row.thread_id}/status`,
		"PUT",
		{ status: "done", revision: state.revision },
		k.key,
	);
	assert.equal(changed.status, 200, await changed.clone().text());
	assert.equal((await changed.json()).updated_by, `api-key:${k.id}`);
	const tagResponse = await call(
		"tags",
		"POST",
		{ name: "Key test", color: "#3366ff" },
		undefined,
		"admin",
	);
	assert.equal(tagResponse.status, 201, await tagResponse.clone().text());
	const tag = await tagResponse.json();
	for (const method of ["PUT", "DELETE"])
		assert.equal(
			(
				await call(
					`${base}/threads/${row.thread_id}/tags/${tag.id}`,
					method,
					undefined,
					k.key,
				)
			).status,
			204,
		);
	assert.equal(
		(
			await call(
				`${base}/tags/bulk`,
				"POST",
				{ thread_ids: [row.thread_id], tag_id: tag.id, action: "add" },
				k.key,
			)
		).status,
		204,
	);
	for (const [path, method, body] of [
		[`${base}/emails/${email!.id}`, "DELETE", undefined],
		[`${base}/folders`, "POST", { name: "No" }],
		[`mailboxes/${other}/emails/${email!.id}`, "PUT", { read: true }],
		["tags", "POST", { name: "No" }],
	] as const)
		assert.equal((await call(path, method, body, k.key)).status, 403);
});
