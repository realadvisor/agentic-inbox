import { test } from "node:test";
import assert from "node:assert/strict";
import SwaggerParser from "@apidevtools/swagger-parser";
import { documentation } from "../server/docs";
import { createApi } from "../server/api";
import { connect } from "../server/db";
import spec from "../openapi.json";

test("OpenAPI is valid and covers every implemented API operation", async () => {
	await SwaggerParser.validate("openapi.json");
	const db = connect();
	try {
		const api = createApi(db, { readAttachment: async () => null });
		const actual = api.routes
			.filter(
				(r) =>
					["GET", "POST", "PUT", "DELETE"].includes(r.method) &&
					!r.path.startsWith("/api/docs") &&
					!r.path.startsWith("/api/openapi"),
			)
			.map((r) => `${r.method} ${r.path.replace(/:([a-zA-Z]+)/g, "{$1}")}`)
			.sort();
		const documented = Object.entries(spec.paths)
			.flatMap(([path, methods]) =>
				Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
			)
			.sort();
		assert.deepEqual(documented, actual);
	} finally {
		await db.end();
	}
});
test("Scalar uses the checked-in spec, local assets and no proxy", async () => {
	const docs = documentation();
	const response = await docs.request("/api/docs");
	assert.equal(response.status, 200);
	const html = await response.text();
	assert.ok(html.includes("/vendor/scalar.js"));
	assert.ok(html.includes("/api/openapi.json"));
	assert.ok(!html.includes("https://cdn.jsdelivr.net"));
	assert.match(html, /"proxyUrl":\s*""/);
	const contract = await docs.request("/api/openapi.json");
	assert.equal(contract.headers.get("cache-control"), "no-store");
	assert.deepEqual(await contract.json(), spec);
});
