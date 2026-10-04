import { pathToFileURL } from "node:url";

export async function verifyDeployment(headers, transport = fetch) {
	// Redirects are authentication failures, never evidence that the application is ready.
	const response = await transport("https://inbox.realadvisor.com/api/health", {
		headers,
		redirect: "manual",
		signal: AbortSignal.timeout(25000),
	});
	if (
		response.status !== 200 ||
		!response.headers.get("content-type")?.includes("application/json")
	)
		return false;
	const body = await response.json().catch(() => null);
	return body?.status === "ready";
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	const id = process.env.HEALTH_ACCESS_CLIENT_ID;
	const secret = process.env.HEALTH_ACCESS_CLIENT_SECRET;
	if (!id || !secret)
		throw new Error("Missing authenticated readiness credentials");
	let ready = false;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			ready = await verifyDeployment({
				"CF-Access-Client-Id": id,
				"CF-Access-Client-Secret": secret,
			});
		} catch {
			/* Report no response contents or credentials. */
		}
		if (ready) break;
		if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 5000));
	}
	if (!ready) {
		console.error(
			"Authenticated application readiness failed; inspect Access configuration, migrations and Worker dependencies.",
		);
		process.exitCode = 1;
	} else console.log("Authenticated application readiness passed.");
}
