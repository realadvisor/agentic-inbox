import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connect } from "./db";
import { createApi } from "./api";
import { localAttachments } from "./local-attachments";

const db = connect();
await db`SELECT 1 FROM inbox_migrations LIMIT 1`;
const app = createApi(db, { readAttachment: localAttachments() });
app.get("*", serveStatic({ root: "./build/client" }));
app.get("*", serveStatic({ path: "./build/client/index.html" }));
const port = Number(process.env.PORT || 4311);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
	console.log(
		`Synthetic inbox API: http://127.0.0.1:${port} (Postgres; outbound delivery disabled)`
	);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () =>
		server.close(() => {
			void db.end().then(() => process.exit(0));
		})
	);
}
