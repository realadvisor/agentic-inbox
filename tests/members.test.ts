import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { createApi } from "../server/api";
import { resolveMember, resolveAccessRole } from "../server/members";
const schema = "members_" + Date.now();
const root = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const admin = "owner@realadvisor.com";
before(async () => {
	await root.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(db);
	assert.deepEqual(
		(await db`SELECT email,role FROM inbox_members ORDER BY email`).map(
			(row) => [row.email, row.role],
		),
		[
			["anastasia@realadvisor.com", "user"],
			["guillaume@realadvisor.com", "user"],
			["joan@realadvisor.com", "user"],
			["jonas@realadvisor.com", "admin"],
		],
	);
	await db`DELETE FROM inbox_members WHERE email='anastasia@realadvisor.com'`;
	await migrate(db);
	assert.equal(
		(
			await db`SELECT 1 FROM inbox_members WHERE email='anastasia@realadvisor.com'`
		).length,
		0,
		"rollout must not restore removed members on subsequent deployments",
	);
	await db`TRUNCATE inbox_members, inbox_member_audit`;
	await resolveMember(db, admin, [admin]);
});
after(async () => {
	await db.end();
	await root.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await root.end();
});
async function call(
	actor: string,
	path: string,
	method = "GET",
	body?: unknown,
) {
	const role = await resolveMember(db, actor, [admin]);
	const api = createApi(db, {
		mode: "live",
		actor,
		actorRole: role ?? undefined,
		membershipEnabled: true,
		readAttachment: async () => null,
	});
	return api.request(`http://127.0.0.1:4311/api/v1/${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
}
test("admins add normalized corporate emails; foreign domains and duplicates are rejected", async () => {
	assert.equal(
		(
			await call(admin, "access/members", "POST", {
				email: " Anastasia@REALADVISOR.COM ",
				role: "user",
			})
		).status,
		201,
	);
	for (const email of [
		"a@example.com",
		"a@realadvisor.com.evil.com",
		"a@sub.realadvisor.com",
		"a@@realadvisor.com",
	])
		assert.equal(
			(await call(admin, "access/members", "POST", { email, role: "user" }))
				.status,
			400,
		);
	assert.equal(
		(
			await call(admin, "access/members", "POST", {
				email: "anastasia@realadvisor.com",
				role: "user",
			})
		).status,
		409,
	);
	assert.equal(
		await resolveMember(db, "ANASTASIA@realadvisor.com", []),
		"user",
	);
	assert.equal(await resolveMember(db, "stranger@realadvisor.com", []), null);
	assert.equal(
		(await call("stranger@realadvisor.com", "mailboxes")).status,
		403,
	);
});
test("users can see members and mailboxes but cannot manage people or configuration", async () => {
	const user = "anastasia@realadvisor.com";
	assert.equal((await call(user, "access/members")).status, 200);
	assert.equal((await call(user, "mailboxes")).status, 200);
	assert.equal(
		(
			await call(user, "access/members", "POST", {
				email: "new@realadvisor.com",
				role: "admin",
			})
		).status,
		403,
	);
	assert.equal(
		(await call(user, `access/members/${user}`, "PUT", { role: "admin" }))
			.status,
		403,
	);
	assert.equal(
		(
			await call(user, "tags", "POST", {
				name: "unauthorized",
				color: "#112233",
			})
		).status,
		403,
	);
	assert.equal(
		(await call(user, "agent/models/refresh", "POST", {})).status,
		403,
	);
	assert.equal(
		(
			await call(
				user,
				"mailboxes/test@ingest.realadvisor.com/agent/settings",
				"PUT",
				{},
			)
		).status,
		403,
	);
	assert.equal(
		(await call(user, "webhooks/test@ingest.realadvisor.com")).status,
		403,
	);
});
test("last administrator cannot be demoted or removed, including concurrent requests", async () => {
	assert.equal(
		(await call(admin, `access/members/${admin}`, "DELETE")).status,
		409,
	);
	assert.equal(
		(await call(admin, `access/members/${admin}`, "PUT", { role: "user" }))
			.status,
		409,
	);
	const second = "second@realadvisor.com";
	assert.equal(
		(
			await call(admin, "access/members", "POST", {
				email: second,
				role: "admin",
			})
		).status,
		201,
	);
	const result = await Promise.all([
		call(admin, `access/members/${admin}`, "PUT", { role: "user" }),
		call(second, `access/members/${second}`, "PUT", { role: "user" }),
	]);
	assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
	const [remaining] =
		await db`SELECT email FROM inbox_members WHERE role='admin'`;
	const removed = remaining.email === admin ? second : admin;
	assert.equal(
		(await call(remaining.email, `access/members/${removed}`, "DELETE")).status,
		204,
	);
	assert.equal(
		await resolveMember(db, removed, [admin]),
		null,
		"bootstrap must not restore a removed admin",
	);
	assert.ok(
		(
			await db`SELECT 1 FROM inbox_member_audit WHERE email=${removed} AND new_role IS NULL`
		).length,
	);
});
test("production membership management stays unavailable until rollout is enabled", async () => {
	const api = createApi(db, {
		mode: "live",
		actor: admin,
		mailboxAdmins: [admin],
		readAttachment: async () => null,
	});
	assert.equal(
		(await api.request("http://127.0.0.1:4311/api/v1/access/members")).status,
		503,
	);
});

test("disabled membership preserves existing configuration permissions", async () => {
	const api = createApi(db, {
		mode: "live",
		actor: "existing@realadvisor.com",
		readAttachment: async () => null,
	});
	const response = await api.request("http://127.0.0.1:4311/api/v1/tags", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "Legacy permission", color: "#112233" }),
	});
	assert.equal(response.status, 201);
});

test("only explicitly approved verified service identities receive user access", async () => {
	const identity = {
		subject: "integration.access",
		email: "integration.access",
		kind: "service" as const,
	};
	assert.equal(await resolveAccessRole(db, identity, [], []), null);
	assert.equal(
		await resolveAccessRole(db, identity, [], [identity.email]),
		"user",
	);
	assert.equal(
		await resolveAccessRole(
			db,
			{ ...identity, kind: "user" },
			[],
			[identity.email],
		),
		null,
	);
});
