import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "./db";

export const apiKeyPermissions = [
	"mail:read",
	"drafts:manage",
	"mail:send",
	"senders:manage",
	"conversations:manage",
	"webhooks:manage",
	"classifications:read",
	"classifications:review",
	"classifications:run",
	"folders:manage",
	"agent:use",
] as const;

export type ApiKey = {
	id: string;
	mailbox_ids: string[];
	permissions: string[];
};
export type KeyVariables = { apiKey?: ApiKey };
export async function hashApiKey(token: string) {
	return Buffer.from(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
	).toString("hex");
}
export async function authenticateApiKey(
	db: Database,
	authorization: string,
): Promise<ApiKey> {
	const match = /^Bearer (inbox_[a-f0-9]{64})$/i.exec(authorization);
	if (!match) throw new HTTPException(401, { message: "Invalid API key" });
	const hash = await hashApiKey(match[1]);
	// Never cache authentication: revocation and expiry take effect on the next request.
	const [key] = await db<
		ApiKey[]
	>`UPDATE inbox_api_keys SET last_used_at=now(),request_count=request_count+1 WHERE token_hash=${hash} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) RETURNING id,to_json(mailbox_ids) AS mailbox_ids,to_json(permissions) AS permissions`;
	if (!key)
		throw new HTTPException(401, { message: "Invalid or expired API key" });
	return key;
}

// Explicit allowlist: new API routes are inaccessible to keys until reviewed here.
export function keyCanRequest(key: ApiKey, method: string, path: string) {
	let segments: string[];
	try {
		segments = path.split("/").map(decodeURIComponent);
	} catch {
		return false;
	}
	if (
		segments.some(
			(s) => s.includes("/") || s.includes("\\") || s === "." || s === "..",
		)
	)
		return false;
	const [, api, v1, resource, mailbox, ...rest] = segments;
	if (api !== "api" || v1 !== "v1") return false;
	const read = method === "GET" || method === "HEAD";
	if (read && path === "/api/v1/config") return true;
	if (read && path === "/api/v1/sender-identities")
		return key.permissions.some((p) =>
			["mail:read", "mail:send", "drafts:manage", "senders:manage"].includes(p),
		);
	if (
		resource === "sender-identities" &&
		((method === "POST" && segments.length === 4) ||
			(["PUT", "DELETE"].includes(method) && segments.length === 5))
	)
		return key.permissions.includes("senders:manage");
	if (method === "PATCH" && path === "/api/v1/inbox-settings")
		return key.permissions.includes("senders:manage");
	if (
		read &&
		["/api/v1/tags", "/api/v1/tag-groups", "/api/v1/mailboxes"].includes(path)
	)
		return true;
	if (resource === "classification") {
		const [, , , , kind, box, thread, action] = segments;
		if (!key.mailbox_ids.includes(box)) return false;
		if (kind === "results")
			return (
				(read &&
					segments.length === 6 &&
					key.permissions.includes("classifications:read")) ||
				(method === "PUT" &&
					segments.length === 8 &&
					key.permissions.includes("classifications:review"))
			);
		if (kind === "threads" && thread)
			return (
				(read &&
					(segments.length === 7 ||
						(segments.length === 8 && action === "classifications")) &&
					key.permissions.includes("classifications:read")) ||
				(method === "POST" &&
					segments.length === 8 &&
					action === "rerun" &&
					key.permissions.includes("classifications:run"))
			);
		return false;
	}
	if (!key.mailbox_ids.includes(mailbox)) return false;
	if (resource === "webhooks")
		return (
			key.permissions.includes("webhooks:manage") &&
			["GET", "HEAD", "POST", "PUT", "DELETE"].includes(method)
		);
	if (resource !== "mailboxes") return false;
	const route = rest.join("/");
	if (
		key.permissions.includes("agent:use") &&
		key.permissions.includes("mail:read") &&
		((read && /^(agent|agent\/(compose|conversations))$/.test(route)) ||
			(method === "POST" &&
				/^agent\/(compose|conversations|chat|stop)$/.test(route)))
	)
		return true;
	if (
		key.permissions.includes("folders:manage") &&
		((read && route === "folders") ||
			(method === "POST" && route === "folders") ||
			(["PUT", "DELETE"].includes(method) && /^folders\/[^/]+$/.test(route)))
	)
		return true;
	if (read && key.permissions.includes("mail:read"))
		return (
			rest.length === 0 ||
			/^(emails|search|folders|recipients)$/.test(route) ||
			/^emails\/[^/]+(?:\/attachments\/[^/]+)?$/.test(route) ||
			/^threads\/[^/]+(?:\/status)?$/.test(route)
		);
	if (
		key.permissions.includes("drafts:manage") &&
		((method === "POST" && route === "drafts") ||
			(method === "DELETE" && /^emails\/[^/]+$/.test(route)))
	)
		return true; // DELETE also verifies that the target is a draft in the handler.
	if (
		key.permissions.includes("mail:send") &&
		method === "POST" &&
		/^(emails|emails\/[^/]+\/(reply|forward))$/.test(route)
	)
		return true;
	if (key.permissions.includes("conversations:manage"))
		return (
			(method === "PUT" && /^emails\/[^/]+$/.test(route)) ||
			(method === "POST" && /^emails\/[^/]+\/move$/.test(route)) ||
			(method === "PUT" && /^threads\/[^/]+\/status$/.test(route)) ||
			(method === "POST" && /^threads\/[^/]+\/read$/.test(route)) ||
			(["PUT", "DELETE"].includes(method) &&
				/^threads\/[^/]+\/tags\/[^/]+$/.test(route)) ||
			(method === "POST" && route === "tags/bulk")
		);
	return false;
}

const input = z
	.object({
		name: z.string().trim().min(1).max(80),
		mailbox_ids: z
			.array(z.string().min(1).max(254))
			.min(1)
			.max(100)
			.transform((v) => [...new Set(v)]),
		permissions: z
			.array(z.enum(apiKeyPermissions))
			.min(1)
			.max(apiKeyPermissions.length)
			.transform((v) => [...new Set(v)]),
		expires_at: z.string().datetime().nullable().optional(),
	})
	.strict();
export function apiKeysApi(
	db: Database,
	options: { admin: boolean; actor: string },
) {
	const app = new Hono<{ Variables: KeyVariables }>();
	app.use("*", async (c, next) => {
		if (!options.admin || c.get("apiKey"))
			throw new HTTPException(403, {
				message: "Administrator access required",
			});
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.get("/", async (c) =>
		c.json(
			await db`SELECT id,name,prefix,to_json(mailbox_ids) AS mailbox_ids,to_json(permissions) AS permissions,created_by,created_at,expires_at,last_used_at,request_count,revoked_at FROM inbox_api_keys ORDER BY created_at DESC`,
		),
	);
	app.post("/", async (c) => {
		const data = input.parse(await c.req.json());
		if (data.expires_at && Date.parse(data.expires_at) <= Date.now())
			throw new HTTPException(400, { message: "Expiry must be in the future" });
		const boxes =
			await db`SELECT id FROM mailboxes WHERE id IN ${db(data.mailbox_ids)}`;
		if (boxes.length !== data.mailbox_ids.length)
			throw new HTTPException(400, { message: "Choose existing mailboxes" });
		const token =
			"inbox_" +
			Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
		const [key] =
			await db`INSERT INTO inbox_api_keys(name,token_hash,prefix,mailbox_ids,permissions,created_by,expires_at) VALUES(${data.name},${await hashApiKey(token)},${token.slice(0, 14)},ARRAY(SELECT jsonb_array_elements_text(${db.json(data.mailbox_ids)}::jsonb)),ARRAY(SELECT jsonb_array_elements_text(${db.json(data.permissions)}::jsonb)),${options.actor},${data.expires_at ?? null}) RETURNING id`;
		return c.json({ id: key.id, key: token }, 201);
	});
	app.delete("/:id", async (c) => {
		const id = z.string().uuid().parse(c.req.param("id"));
		const rows =
			await db`UPDATE inbox_api_keys SET revoked_at=coalesce(revoked_at,now()) WHERE id=${id} RETURNING id`;
		if (!rows.length)
			throw new HTTPException(404, { message: "API key not found" });
		return c.body(null, 204);
	});
	return app;
}
