import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connect } from "../../server/db";
import { migrate } from "../../server/migrate";
import { createApi } from "../../server/api";
import { InboxStore } from "../../server/store";
import { processJob } from "../../server/classification/queue";
const schema = "rules_browser_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
let server: ReturnType<typeof serve>, origin: string;
const mailbox = "rules-ui@example.test";
test.beforeAll(async () => {
	await admin.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(db);
	const store = new InboxStore(db);
	await store.createMailbox(mailbox, "Rules");
	await db`UPDATE classifiers SET enabled=false`;
	const [tag] =
		await db`INSERT INTO tags(name,color) VALUES('Saved answer test','#64748b') RETURNING id`;
	const [classifier] =
		await db`INSERT INTO classifiers(tag_id,question,enabled) VALUES(${tag.id},'Should this apply?',true) RETURNING id`;
	const email = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Uncertain example",
		body: "Please help.",
	});
	const [job] =
		await db`SELECT token FROM conversation_classifications WHERE thread_id=${email!.thread_id!} AND classifier_id=${classifier.id}`;
	await processJob(db, "fake", job.token, async () =>
		Response.json({
			model: "test",
			answers: { match: { type: "noul", noul: 0.5 } },
		}),
	);
	await db`UPDATE classifiers SET decision_rules='{"yes":0.45,"no":0.15}' WHERE id=${classifier.id}`;
	let app: ReturnType<typeof createApi>;
	server = serve({
		fetch: (r) => app.fetch(r),
		hostname: "127.0.0.1",
		port: 0,
	});
	await new Promise<void>((r) => server.on("listening", r));
	const address = server.address();
	if (!address || typeof address === "string") throw Error("No port");
	origin = "http://127.0.0.1:" + address.port;
	app = createApi(db, {
		readAttachment: async () => null,
		classifiersEnabled: true,
		origin,
	});
	app.get("*", serveStatic({ root: "./build/client" }));
	app.get("*", serveStatic({ path: "./build/client/index.html" }));
});
test.afterAll(async () => {
	if (server) await new Promise<void>((r) => server.close(() => r()));
	await db.end();
	await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await admin.end();
});
test("preview and apply saved rules in the tag drawer", async ({ page }) => {
	await page.goto(`${origin}/mailbox/${mailbox}/settings?tab=tags`);
	await page.getByRole("button", { name: "Tags", exact: true }).click();
	await page.getByRole("button", { name: /Saved answer test/ }).click();
	await page
		.getByRole("button", { name: "Preview saved rules", exact: true })
		.click();
	await expect(
		page.getByRole("button", {
			name: "Apply to 1 pending reviews",
			exact: true,
		}),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Apply to 1 pending reviews", exact: true })
		.click();
	await expect(
		page.getByText("Applied to 1 decisions · 0 remain", { exact: true }),
	).toBeVisible();
	const [j] =
		await db`SELECT status FROM conversation_classifications WHERE source='jev'`;
	expect(j.status).toBe("complete");
});
