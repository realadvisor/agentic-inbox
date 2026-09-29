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
		assert.equal((await verifyAccess(valid, issuer, "inbox")).kind, "user");
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

test("Access accepts service tokens via common_name when email is absent", async () => {
	const { publicKey, privateKey } = await generateKeyPair("RS256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "svc-key",
		alg: "RS256",
		use: "sig",
	};
	const issuer = "https://service-test.cloudflareaccess.com";
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		assert.equal(String(input), `${issuer}/cdn-cgi/access/certs`);
		return Response.json({ keys: [jwk] });
	};
	try {
		const clientId = "cbad515f2134f6b19ee8405fdd98e226.access";
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({
			type: "app",
			common_name: clientId,
		})
			.setProtectedHeader({ alg: "RS256", kid: "svc-key" })
			.setIssuer(issuer)
			.setAudience("inbox")
			.setSubject("")
			.setIssuedAt(now)
			.setExpirationTime(now + 60)
			.sign(privateKey);
		const identity = await verifyAccess(token, issuer, "inbox");
		assert.equal(identity.email, clientId);
		assert.equal(identity.kind, "service");
		assert.equal(identity.subject, clientId);

		await assert.rejects(
			verifyAccess(
				await new SignJWT({ type: "app" })
					.setProtectedHeader({ alg: "RS256", kid: "svc-key" })
					.setIssuer(issuer)
					.setAudience("inbox")
					.setIssuedAt(now)
					.setExpirationTime(now + 60)
					.sign(privateKey),
				issuer,
				"inbox",
			),
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
