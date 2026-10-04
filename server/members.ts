import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "./db";
import type { AccessIdentity } from "./access";

export async function resolveAccessRole(
	db: Database,
	identity: AccessIdentity,
	bootstrapAdmins: string[],
): Promise<MemberRole | null> {
	if (identity.kind === "service") return null; // Service authorization never creates or inherits human membership.
	return resolveMember(db, identity.email, bootstrapAdmins);
}

export const memberEmail = z
	.string()
	.trim()
	.toLowerCase()
	.email()
	.max(254)
	.refine(
		(email) => email.split("@")[1] === "realadvisor.com",
		"Use an @realadvisor.com email address",
	);
export type MemberRole = "admin" | "user";
const roleSchema = z.enum(["admin", "user"]);
const membershipLock = 7342232;

// Called with the verified Access identity, never a browser-supplied email header.
export async function resolveMember(
	db: Database,
	email: string,
	bootstrapAdmins: string[],
): Promise<MemberRole | null> {
	const parsed = memberEmail.safeParse(email);
	if (!parsed.success) return null;
	const [member] =
		await db`SELECT role FROM inbox_members WHERE email=${parsed.data}`;
	if (member) return member.role as MemberRole;
	const seeds = bootstrapAdmins.map((value) => memberEmail.parse(value));
	if (!seeds.includes(parsed.data)) return null;
	// Bootstrap only an empty installation. Once populated, removal/demotion is final.
	return db.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(${membershipLock})`;
		const [existing] =
			await tx`SELECT role FROM inbox_members WHERE email=${parsed.data}`;
		if (existing) return existing.role as MemberRole;
		if ((await tx`SELECT 1 FROM inbox_members LIMIT 1`).length) return null;
		for (const seed of new Set(seeds)) {
			await tx`INSERT INTO inbox_members(email,role,created_by) VALUES(${seed},'admin','bootstrap')`;
			await tx`INSERT INTO inbox_member_audit(email,actor,new_role) VALUES(${seed},'bootstrap','admin')`;
		}
		return "admin";
	});
}

export function membersApi(
	db: Database,
	options: { actor: string; admin: boolean },
) {
	const app = new Hono();
	app.get("/", async (c) =>
		c.json({
			members:
				await db`SELECT email,role,created_at,created_by FROM inbox_members ORDER BY role,email`,
		}),
	);
	app.use("*", async (c, next) => {
		if (!options.admin)
			throw new HTTPException(403, {
				message: "Administrator access required",
			});
		await next();
	});
	async function change(
		email: string,
		role: MemberRole | null,
		create: boolean,
	) {
		return db.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(${membershipLock})`;
			// Recheck the actor under the mutation lock: a concurrent demotion cannot grant access.
			if (
				options.actor !== "local-preview" &&
				!(
					await tx`SELECT 1 FROM inbox_members WHERE email=${options.actor} AND role='admin'`
				).length
			)
				throw new HTTPException(403, {
					message: "Administrator access required",
				});
			const [current] =
				await tx`SELECT role FROM inbox_members WHERE email=${email}`;
			if (create && current)
				throw new HTTPException(409, {
					message: "This person already has access",
				});
			if (!create && !current)
				throw new HTTPException(404, { message: "Member not found" });
			if (current?.role === "admin" && role !== "admin") {
				const [admins] =
					await tx`SELECT count(*)::int n FROM inbox_members WHERE role='admin'`;
				if (admins.n <= 1)
					throw new HTTPException(409, {
						message: "Keep at least one administrator",
					});
			}
			if (create)
				await tx`INSERT INTO inbox_members(email,role,created_by) VALUES(${email},${role},${options.actor})`;
			else if (role)
				await tx`UPDATE inbox_members SET role=${role},updated_at=now() WHERE email=${email}`;
			else await tx`DELETE FROM inbox_members WHERE email=${email}`;
			if (current?.role !== role)
				await tx`INSERT INTO inbox_member_audit(email,actor,old_role,new_role) VALUES(${email},${options.actor},${current?.role ?? null},${role})`;
		});
	}
	app.post("/", async (c) => {
		const data = z
			.object({ email: memberEmail, role: roleSchema.default("user") })
			.strict()
			.parse(await c.req.json());
		await change(data.email, data.role, true);
		return c.json({ email: data.email, role: data.role }, 201);
	});
	app.put("/:email", async (c) => {
		const email = memberEmail.parse(c.req.param("email"));
		const { role } = z
			.object({ role: roleSchema })
			.strict()
			.parse(await c.req.json());
		await change(email, role, false);
		return c.json({ email, role });
	});
	app.delete("/:email", async (c) => {
		await change(memberEmail.parse(c.req.param("email")), null, false);
		return c.body(null, 204);
	});
	return app;
}
