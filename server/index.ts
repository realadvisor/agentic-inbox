import { agentProviders } from "./agent/providers";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connect } from "./db";
import { createApi } from "./api";
import { localAttachments } from "./local-attachments";

const preview = process.env.CLASSIFIER_PREVIEW === "1";
if (
	preview &&
	!["localhost", "127.0.0.1", "[::1]"].includes(
		new URL(process.env.DATABASE_URL!).hostname,
	)
) {
	throw new Error("Classifier preview requires local Postgres.");
}
const port = Number(process.env.PORT || 4311);
const db = connect(undefined, preview ? "classifier_preview" : "public");
let previewTimer: ReturnType<typeof setInterval> | undefined;
if (preview) {
	const admin = connect();
	await admin`CREATE SCHEMA IF NOT EXISTS classifier_preview`;
	await admin.end();
	const { setupPreview } = await import("./preview/setup");
	await setupPreview(db);
}
await db`SELECT 1 FROM inbox_migrations LIMIT 1`;
const previewModule = preview ? await import("./preview/api") : null;
const app = createApi(db, {
	jevKey: process.env.TYPESAFE_API_KEY,
	agent: agentProviders(undefined, process.env.AI_GATEWAY_API_KEY),

	classifiersEnabled: process.env.CLASSIFIERS_ENABLED === "1",
	previewRoutes: previewModule?.previewApi(db),
	readAttachment: localAttachments(),
	classifierPreview: preview,
	origin: preview ? `http://127.0.0.1:${port}` : process.env.PUBLIC_ORIGIN,
});
if (preview) {
	const { tickPreview } = await import("./preview/api");

	let processing = false;
	previewTimer = setInterval(async () => {
		if (processing) return;
		processing = true;
		try {
			await tickPreview(db);
		} catch (error) {
			console.error("Preview job failed", error);
		} finally {
			processing = false;
		}
	}, 1000);
}
app.get("/vendor/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ root: "./build/client" }));
app.get("*", serveStatic({ path: "./build/client/index.html" }));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
	console.log(
		`Synthetic inbox API: http://127.0.0.1:${port} (Postgres; outbound delivery disabled)`,
	);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () =>
		server.close(() => {
			if (previewTimer) clearInterval(previewTimer);
			void db.end().then(() => process.exit(0));
		}),
	);
}
