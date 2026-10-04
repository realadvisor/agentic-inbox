import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error deployment runner is intentionally standalone JavaScript
import { verifyDeployment } from "../scripts/verify-deployment.mjs";
test("deployment probe rejects login redirects, HTML, unhealthy and old shallow health responses", async () => {
	for (const response of [
		new Response(null, { status: 302 }),
		new Response("<html>login</html>"),
		Response.json({ status: "ok" }),
		Response.json({ status: "unavailable" }, { status: 503 }),
		Response.json(null),
	]) {
		assert.equal(await verifyDeployment({}, async () => response), false);
	}
	assert.equal(
		await verifyDeployment(
			{ "CF-Access-Client-Id": "synthetic" },
			async (url: string, options: RequestInit) => {
				assert.equal(url, "https://inbox.realadvisor.com/api/health");
				assert.equal(options.redirect, "manual");
				assert.ok(options.signal);
				return Response.json({ status: "ready" });
			},
		),
		true,
	);
});
