import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { createApi } from "../server/api";
import { ingest, type ObjectStore } from "../server/inbound";
import {
	readiness,
	pruneInboundRecovery,
	requiredMigrations,
} from "../server/operations";
const schema = "test_recovery_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const mailbox = "privacy@ingest.realadvisor.com";
const blobs = new Map<string, ArrayBuffer>();
let failAttachment = false;
const objects: ObjectStore = {
	get: async (key) =>
		blobs.has(key) ? { arrayBuffer: async () => blobs.get(key)! } : null,
	put: async (key, value) => {
		if (failAttachment && key.startsWith("inbound-attachments/"))
			throw new Error("synthetic private failure content");
		blobs.set(
			key,
			typeof value === "string"
				? new TextEncoder().encode(value).buffer
				: value instanceof Uint8Array
					? value.slice().buffer
					: value,
		);
	},
};
const api = () =>
	createApi(db, { readAttachment: async () => null, recoveryObjects: objects });
const request = (path: string, method = "GET") =>
	api().request("http://localhost/api/v1/operations" + path, {
		method,
		headers: { "content-type": "application/json" },
	});
const message = (raw: string) => ({
	to: mailbox,
	from: "synthetic@example.test",
	raw: new Blob([raw]).stream(),
	rawSize: raw.length,
	setReject(reason: string) {
		throw new Error(reason);
	},
});
const mime = (id: string) =>
	`From: Synthetic <synthetic@example.test>\r\nTo: ${mailbox}\r\nMessage-ID: <${id}@example.test>\r\nSubject: Recovery fixture\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=fixture\r\n\r\n--fixture\r\nContent-Type: text/plain\r\n\r\nSynthetic body\r\n--fixture\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=fixture.txt\r\n\r\nSynthetic attachment\r\n--fixture--`;
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	await new InboxStore(db).createMailbox(mailbox, "Synthetic");
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

test("readiness fails closed for missing migrations, DB and dependencies, without leaking details", async () => {
	assert.equal(await readiness(db, async () => true), true);
	await db`DELETE FROM inbox_migrations WHERE version=45`;
	assert.equal(await readiness(db), false);
	await db`INSERT INTO inbox_migrations VALUES(45)`;
	assert.equal(
		await readiness(db, async () => {
			throw new Error("secret");
		}),
		false,
	);
	const response = await createApi(db, {
		readAttachment: async () => null,
		readinessCheck: async () => false,
	}).request("http://localhost/api/health");
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { status: "unavailable" });
	const disconnected = connect(process.env.DATABASE_URL, schema);
	await disconnected.end();
	assert.equal(await readiness(disconnected), false);
});

test("attachment failure rolls back mail and trigger effects; concurrent replay and redelivery commit exactly once", async () => {
	await db`INSERT INTO agent_settings(mailbox_id,auto_draft) VALUES(${mailbox},true) ON CONFLICT(mailbox_id) DO UPDATE SET auto_draft=true`;
	const raw = mime("recover");
	failAttachment = true;
	await assert.rejects(
		ingest(message(raw), db, objects),
		/synthetic private failure/,
	);
	const [record] =
		await db`SELECT * FROM inbound_recovery WHERE status='failed'`;
	assert.ok(record);
	assert.equal(record.size, new TextEncoder().encode(raw).length);
	assert.equal(
		(await db`SELECT id FROM emails WHERE message_id='<recover@example.test>'`)
			.length,
		0,
	);
	assert.equal((await db`SELECT * FROM webhook_events`).length, 0);
	assert.equal((await db`SELECT * FROM agent_jobs`).length, 0);
	failAttachment = false;
	const [a, b] = await Promise.all([
		request("/" + record.id + "/replay", "POST"),
		request("/" + record.id + "/replay", "POST"),
		ingest(message(raw), db, objects),
	]);
	assert.equal(a.status, 200);
	assert.equal(b.status, 200);
	assert.equal(
		(await db`SELECT id FROM emails WHERE message_id='<recover@example.test>'`)
			.length,
		1,
	);
	assert.equal((await db`SELECT id FROM attachments`).length, 1);
	assert.equal((await db`SELECT * FROM agent_jobs`).length, 1);
	const events = await db`SELECT * FROM webhook_events`;
	await request("/" + record.id + "/replay", "POST");
	assert.deepEqual(await db`SELECT * FROM webhook_events`, events);
	assert.equal((await db`SELECT * FROM agent_jobs`).length, 1);
	assert.equal(
		(await db`SELECT status FROM inbound_recovery WHERE id=${record.id}`)[0]
			.status,
		"complete",
	);
	assert.equal((await request("")).status, 200);
});

test("replay rejects corrupt/missing raw MIME and unauthorized callers; failed records survive repeat failure", async () => {
	failAttachment = true;
	await assert.rejects(ingest(message(mime("corrupt")), db, objects));
	const [record] =
		await db`SELECT * FROM inbound_recovery WHERE status='failed'`;
	const original = blobs.get(record.raw_storage_key)!;
	blobs.delete(record.raw_storage_key);
	assert.equal(
		(await request("/" + record.id + "/replay", "POST")).status,
		409,
	);
	blobs.set(record.raw_storage_key, new TextEncoder().encode("corrupt").buffer);
	assert.equal(
		(await request("/" + record.id + "/replay", "POST")).status,
		409,
	);
	blobs.set(record.raw_storage_key, original);
	assert.equal(
		(await request("/" + record.id + "/replay", "POST")).status,
		503,
	);
	const restricted = createApi(db, {
		mode: "live",
		actorRole: "user",
		membershipEnabled: true,
		readAttachment: async () => null,
		recoveryObjects: objects,
	});
	for (const [path, method] of [
		["", "GET"],
		["/" + record.id + "/replay", "POST"],
	]) {
		const response = await restricted.request(
			"http://localhost/api/v1/operations" + path,
			{ method, headers: { "content-type": "application/json" } },
		);
		assert.equal(response.status, 403);
	}
	const list = JSON.stringify(await (await request("")).json());
	assert.ok(!list.includes("raw_storage_key"));
	assert.ok(!list.includes("synthetic private"));
	failAttachment = false;
});

test("parser failure is journaled and actual stream bytes are bounded before storage", async () => {
	const raw = "X-Long: " + "x".repeat(260000) + "\r\n\r\nSynthetic";
	await assert.rejects(ingest(message(raw), db, objects));
	assert.ok(
		(await db`SELECT id FROM inbound_recovery WHERE status='failed'`).length >=
			2,
	);
	let cancelled = false;
	const oversized = {
		...message(""),
		rawSize: 1,
		raw: new ReadableStream({
			pull(controller) {
				controller.enqueue(new Uint8Array(1024 * 1024));
			},
			cancel() {
				cancelled = true;
			},
		}),
	};
	const beforeSize = blobs.size;
	await assert.rejects(ingest(oversized, db, objects), /10 MiB/);
	assert.equal(cancelled, true);
	assert.equal(blobs.size, beforeSize);
});

test("Worker readiness requires signed allowed identity, rejects missing config and storage errors; service cannot replay", async () => {
	const { default: worker } = await import("../server/worker");
	const { generateKeyPair, exportJWK, SignJWT } = await import("jose");
	const { privateKey, publicKey } = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "recovery-health",
		alg: "RS256",
		use: "sig",
	};
	const issuer = "https://recovery-health.cloudflareaccess.com";
	const original = globalThis.fetch;
	globalThis.fetch = async () => Response.json({ keys: [jwk] });
	const pending: Promise<unknown>[] = [];
	try {
		const token = await new SignJWT({
			type: "app",
			common_name: "synthetic-health-client",
		})
			.setProtectedHeader({ alg: "RS256", kid: jwk.kid })
			.setIssuer(issuer)
			.setAudience("inbox")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(privateKey);
		const database = new URL(process.env.DATABASE_URL!);
		database.searchParams.set("options", `-c search_path=${schema}`);
		const env = {
			PUBLIC_ORIGIN: "https://inbox.test",
			MAIL_MODE: "live" as const,
			ACCESS_MEMBERSHIP_ENABLED: "true",
			ACCESS_SERVICE_CLIENT_IDS: "synthetic-health-client",
			ACCESS_ISSUER: issuer,
			ACCESS_AUDIENCE: "inbox",
			HYPERDRIVE: { connectionString: database.toString() },
			ATTACHMENTS: objects,
			EMAIL: {
				send: async () => {
					throw new Error("Health must never send");
				},
			},
			ASSETS: { fetch: async () => new Response("page") },
		};
		const ctx = {
			waitUntil: (p: Promise<unknown>) => pending.push(p),
			passThroughOnException() {},
			props: {},
		};
		const call = (path = "/api/health", override = {}, jwt = token) =>
			worker.fetch(
				new Request("https://inbox.test" + path, {
					headers: { "cf-access-jwt-assertion": jwt },
				}),
				{ ...env, ...override },
				ctx,
			);
		assert.equal((await call()).status, 200);
		assert.equal((await call("/api/health", {}, token + "forged")).status, 401);
		assert.equal(
			(await call("/api/health", { ACCESS_SERVICE_CLIENT_IDS: "" })).status,
			403,
		);
		assert.equal((await call("/api/health", { EMAIL: undefined })).status, 503);
		assert.equal(
			(await call("/api/health", { CLASSIFIERS_ENABLED: "true" })).status,
			503,
		);
		const unavailable = await call("/api/health", {
			ATTACHMENTS: {
				...objects,
				get: async () => {
					throw new Error("private storage detail");
				},
			},
		});
		assert.equal(unavailable.status, 503);
		assert.deepEqual(await unavailable.json(), { status: "unavailable" });
		assert.equal((await call("/api/v1/operations")).status, 403);
	} finally {
		globalThis.fetch = original;
		await Promise.all(pending);
	}
});

test("operations reports only stale uncertain sends and unpublished jobs, without changing their state", async () => {
	const store = new InboxStore(db);
	const old = await store.insert(mailbox, {
		sender: mailbox,
		recipient: "fixture@example.test",
		subject: "Synthetic uncertain send",
		body: "Synthetic",
		delivery_status: "unknown",
	});
	const recent = await store.insert(mailbox, {
		sender: mailbox,
		recipient: "fixture@example.test",
		subject: "Synthetic sending",
		body: "Synthetic",
		delivery_status: "sending",
	});
	await db`INSERT INTO outbound_requests(mailbox_id,request_id,payload_hash,email_id,actor,created_at) VALUES(${mailbox},${crypto.randomUUID()},'synthetic',${old!.id},'fixture',now()-interval '16 minutes'),(${mailbox},${crypto.randomUUID()},'synthetic',${recent!.id},'fixture',now())`;
	const staleToken = crypto.randomUUID();
	await db`INSERT INTO classifier_outbox(job_token,created_at) VALUES(${staleToken},now()-interval '31 minutes'),(${crypto.randomUUID()},now())`;
	const result = await (await request("")).json();
	assert.deepEqual(
		result.sends.map((r: { id: string }) => r.id),
		[old!.id],
	);
	assert.deepEqual(
		result.jobs.map((r: { job_token: string }) => r.job_token),
		[staleToken],
	);
	assert.equal(
		(await db`SELECT delivery_status FROM emails WHERE id=${old!.id}`)[0]
			.delivery_status,
		"unknown",
	);
});
test("retention removes only completed metadata and preserves unresolved records and all raw objects", async () => {
	await db`UPDATE inbound_recovery SET updated_at=now()-interval '31 days'`;
	const unresolved =
		await db`SELECT id FROM inbound_recovery WHERE status<>'complete' ORDER BY id`;
	const count = blobs.size;
	await pruneInboundRecovery(db);
	assert.deepEqual(
		await db`SELECT id FROM inbound_recovery ORDER BY id`,
		unresolved,
	);
	assert.equal(blobs.size, count);
});

test("readiness migration manifest matches every checked-in migration", async () => {
	const { readdir } = await import("node:fs/promises");
	const files = await readdir(new URL("../migrations", import.meta.url));
	const versions = files
		.filter((name) => /^\d+_.*\.sql$/.test(name))
		.map((name) => Number(name.split("_")[0]))
		.sort((a, b) => a - b);
	assert.deepEqual(
		[...requiredMigrations].sort((a, b) => a - b),
		versions,
	);
});
test("migration045 upgrades existing mail without creating recovery jobs and reruns safely", async () => {
	const upgradeSchema =
		"test_recovery_upgrade_" + crypto.randomUUID().replaceAll("-", "");
	const upgrade = connect(process.env.DATABASE_URL, upgradeSchema);
	try {
		await admin`CREATE SCHEMA ${admin(upgradeSchema)}`;
		await migrate(upgrade);
		await upgrade`DROP TABLE inbound_recovery`;
		await upgrade`DELETE FROM inbox_migrations WHERE version=45`;
		const store = new InboxStore(upgrade);
		await store.createMailbox(mailbox, "Synthetic upgrade");
		const existing = await store.insert(mailbox, {
			sender: "fixture@example.test",
			recipient: mailbox,
			subject: "Pre-upgrade synthetic mail",
			body: "Synthetic",
		});
		await migrate(upgrade);
		await migrate(upgrade);
		assert.equal((await upgrade`SELECT id FROM emails`)[0].id, existing!.id);
		assert.equal((await upgrade`SELECT id FROM inbound_recovery`).length, 0);
		assert.equal(await readiness(upgrade), true);
	} finally {
		await upgrade.end();
		await admin`DROP SCHEMA ${admin(upgradeSchema)} CASCADE`;
	}
});
