import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export type AccessIdentity =
	| { kind: "user"; subject: string; email: string }
	| { kind: "service"; subject: string; clientId: string };

function accessActor(payload: JWTPayload): AccessIdentity {
	if (payload.type !== "app") {
		throw new Error("An authenticated Access user is required");
	}
	const email =
		typeof payload.email === "string" && payload.email ? payload.email : null;
	// Service tokens have type=app + common_name (client id) and an empty sub/email.
	const commonName =
		typeof payload.common_name === "string" && payload.common_name
			? payload.common_name
			: null;
	const identity = commonName ?? email;
	if (!identity) {
		throw new Error("An authenticated Access user is required");
	}
	const subject =
		typeof payload.sub === "string" && payload.sub ? payload.sub : identity;
	return commonName
		? { subject, clientId: commonName, kind: "service" }
		: { subject, email: email!, kind: "user" };
}

export async function verifyAccess(
	token: string,
	issuer: string,
	audience: string,
) {
	const url = new URL(issuer);
	if (
		url.protocol !== "https:" ||
		!url.hostname.endsWith(".cloudflareaccess.com") ||
		url.pathname !== "/"
	) {
		throw new Error("Invalid Access issuer configuration");
	}
	const normalized = url.origin;
	let keys = keySets.get(normalized);
	if (!keys) {
		keys = createRemoteJWKSet(new URL(`${normalized}/cdn-cgi/access/certs`));
		keySets.set(normalized, keys);
	}
	const { payload } = await jwtVerify(token, keys, {
		issuer: normalized,
		audience,
		algorithms: ["RS256"],
		requiredClaims: ["exp", "iat"],
	});
	return accessActor(payload);
}
