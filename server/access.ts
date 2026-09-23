import { createRemoteJWKSet, jwtVerify } from "jose";

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
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
		requiredClaims: ["exp", "iat", "sub"],
	});
	if (
		payload.type !== "app" ||
		typeof payload.email !== "string" ||
		!payload.email
	) {
		throw new Error("An authenticated Access user is required");
	}
	return { subject: payload.sub!, email: payload.email };
}
