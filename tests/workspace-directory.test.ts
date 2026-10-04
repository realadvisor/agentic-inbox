import { test, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import {
	createDirectorySearch,
	workspaceDirectory,
} from "../server/workspace-directory";
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let privateKey: string;
before(async () => {
	keys = await generateKeyPair("RS256", { extractable: true });
	privateKey = await exportPKCS8(keys.privateKey);
});
const env = () => ({
	GOOGLE_DIRECTORY_SERVICE_ACCOUNT: "directory@example.iam.gserviceaccount.com",
	GOOGLE_DIRECTORY_PRIVATE_KEY: privateKey,
	GOOGLE_DIRECTORY_USER: "directory-reader@example.test",
});

test("people lookup uses delegated read-only scope, names and primary addresses only, and caches requests", async () => {
	let authentications = 0,
		searches = 0;
	const transport: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.hostname === "oauth2.googleapis.com") {
			authentications++;
			const form = new URLSearchParams(String(init?.body));
			const { payload } = await jwtVerify(
				form.get("assertion")!,
				keys.publicKey,
				{
					audience: "https://oauth2.googleapis.com/token",
					issuer: env().GOOGLE_DIRECTORY_SERVICE_ACCOUNT,
				},
			);
			assert.equal(payload.sub, env().GOOGLE_DIRECTORY_USER);
			assert.equal(
				payload.scope,
				"https://www.googleapis.com/auth/directory.readonly",
			);
			return Response.json({ access_token: "test-token", expires_in: 3600 });
		}
		searches++;
		assert.equal(url.origin, "https://people.googleapis.com");
		assert.equal(
			url.searchParams.get("sources"),
			"DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE",
		);
		assert.equal(url.searchParams.get("readMask"), "names,emailAddresses");
		assert.equal(
			new Headers(init?.headers).get("Authorization"),
			"Bearer test-token",
		);
		assert.ok(init?.signal);
		return Response.json({
			people: [
				{
					names: [{ displayName: "Alex Example" }],
					emailAddresses: [
						{ value: "personal@elsewhere.test" },
						{ value: "Alex@example.test", metadata: { primary: true } },
					],
				},
				{ emailAddresses: [{ value: "alex@example.test" }] },
				{ emailAddresses: [{ value: "not an email" }] },
			],
		});
	};
	const search = createDirectorySearch(env(), transport);
	assert.deepEqual(await search("a"), []);
	assert.deepEqual(await search("a".repeat(101)), []);
	const [first, second] = await Promise.all([search(" ALEX "), search("alex")]);
	assert.deepEqual(first, [
		{ name: "Alex Example", email: "alex@example.test" },
	]);
	assert.deepEqual(second, first);
	assert.deepEqual(await search("alex"), first);
	await search("al");
	assert.equal(authentications, 1);
	assert.equal(searches, 2);
});

test("Google failures return no directory results and back off without exposing error details", async () => {
	let calls = 0;
	const search = createDirectorySearch(env(), async () => {
		calls++;
		return Response.json({ error: "private upstream detail" }, { status: 403 });
	});
	assert.deepEqual(await search("alex"), []);
	assert.deepEqual(await search("other"), []);
	assert.equal(calls, 1);
	assert.equal(workspaceDirectory({}), undefined);
	assert.equal(
		workspaceDirectory({ GOOGLE_DIRECTORY_USER: "someone@example.test" }),
		undefined,
	);
});

test("malformed directory responses safely fall back", async () => {
	const search = createDirectorySearch(env(), async (input) =>
		String(input).includes("oauth2")
			? Response.json({ access_token: "token", expires_in: 3600 })
			: Response.json({ people: "invalid" }),
	);
	assert.deepEqual(await search("alex"), []);
});
