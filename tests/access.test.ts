import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { verifyAccess } from "../server/access";

test("Access verifies signatures, audience and expiration before accepting identity", async () => {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "test-key",
		alg: "RS256",
		use: "sig",
	};
	const issuer = "https://signed-test.cloudflareaccess.com";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`);
		return Response.json({ keys: [jwk] });
	};
	try {
		const sign = (aud: string, expires: number) =>
			new SignJWT({ type: "app", email: "tester@example.test" })
				.setProtectedHeader({ alg: "RS256", kid: "test-key" })
				.setIssuer(issuer)
				.setAudience(aud)
				.setSubject("test-user")
				.setIssuedAt()
				.setExpirationTime(expires)
				.sign(privateKey);
		const now = Math.floor(Date.now() / 1000);
		const valid = await sign("inbox", now + 60);
		assert.equal(
			(await verifyAccess(valid, issuer, "inbox")).email,
			"tester@example.test",
		);
		await assert.rejects(
			verifyAccess(await sign("other-app", now + 60), issuer, "inbox"),
		);
		await assert.rejects(
			verifyAccess(await sign("inbox", now - 60), issuer, "inbox"),
		);
		const parts = valid.split(".");
		parts[1] = Buffer.from(
			JSON.stringify({ email: "attacker@example.test" }),
		).toString("base64url");
		await assert.rejects(verifyAccess(parts.join("."), issuer, "inbox"));
	} finally {
		globalThis.fetch = originalFetch;
	}
});
