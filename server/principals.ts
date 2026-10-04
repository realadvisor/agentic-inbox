import { z } from "zod";
import { apiKeyPermissions, keyCanRequest, type ApiKey } from "./api-keys";
import type { MemberRole } from "./members";

export type Scope = Pick<ApiKey, "mailbox_ids" | "permissions">;
export type Principal =
	| { kind: "human"; subject: string; email: string; role?: MemberRole }
	| { kind: "service"; clientId: string; grant: ServiceGrant }
	| ({ kind: "api-key" } & ApiKey);

// Webhook ownership is currently keyed by API key UUID. Services cannot own
// webhooks or administer shared sender configuration; use a scoped inbox key.
const servicePermissions = apiKeyPermissions.filter(
	(p) => p !== "webhooks:manage" && p !== "senders:manage",
);
const grantSchema = z
	.object({
		mailbox_ids: z.array(z.string().min(1).max(254)).max(100),
		permissions: z
			.array(z.enum(["health:read", ...servicePermissions]))
			.max(20),
	})
	.strict();
export type ServiceGrant = z.infer<typeof grantSchema>;

export function servicePrincipal(
	clientId: string,
	config?: string,
): Principal | null {
	try {
		const grants = z.record(grantSchema).parse(JSON.parse(config ?? "{}"));
		if (!Object.hasOwn(grants, clientId)) return null;
		return { kind: "service", clientId, grant: grants[clientId] };
	} catch {
		return null; // Malformed grants never fall back to application-wide access.
	}
}

export function serviceCanRequest(
	principal: Extract<Principal, { kind: "service" }>,
	method: string,
	path: string,
) {
	const { grant } = principal;
	if (method === "GET" && path === "/api/health")
		return grant.permissions.includes("health:read");
	if (
		!grant.mailbox_ids.length ||
		!grant.permissions.some((p) => p !== "health:read")
	)
		return false;
	return keyCanRequest({ id: principal.clientId, ...grant }, method, path);
}

export function principalActor(principal: Principal): string {
	if (principal.kind === "service") return `service:${principal.clientId}`;
	if (principal.kind === "api-key") return `api-key:${principal.id}`;
	return principal.email;
}
