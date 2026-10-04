import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connect } from "../../server/db";
import { migrate } from "../../server/migrate";
import { createApi } from "../../server/api";
import { InboxStore } from "../../server/store";

const schema = "detail_url_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
let server: ReturnType<typeof serve>, origin: string;
const mailbox = "detail-url@example.test";
let emailId: string;
test.beforeAll(async () => {
	await admin.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(db);
	const store = new InboxStore(db);
	await store.createMailbox(mailbox, "Rules");
	await db`UPDATE classifiers SET enabled=false`;
	const email = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: mailbox,
		subject: "Direct link fixture",
		body: "Direct link body",
	});
	emailId = email!.id;
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

test("email drawer follows shareable URLs and browser history", async ({
	page,
}) => {
	const list = `${origin}/mailbox/${mailbox}/emails/all?status=all`;
	await page.goto(list);
	await page.getByText("Direct link fixture", { exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`email=${emailId}`));
	await expect(
		page.getByRole("heading", { name: "Direct link fixture", exact: true }),
	).toBeVisible();
	expect(new URL(page.url()).searchParams.get("status")).toBe("all");
	const direct = page.url();
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Direct link fixture", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page).not.toHaveURL(/email=/);
	await expect(
		page.getByRole("heading", { name: "Direct link fixture", exact: true }),
	).toHaveCount(0);
	await page.goBack();
	await expect(page).toHaveURL(direct);
	await expect(
		page.getByRole("heading", { name: "Direct link fixture", exact: true }),
	).toBeVisible();
	await page.goForward();
	await expect(page).not.toHaveURL(/email=/);
	await expect(
		page.getByRole("heading", { name: "Direct link fixture", exact: true }),
	).toHaveCount(0);
	await page.goto(
		`${origin}/mailbox/${mailbox}/search?q=Direct&email=${emailId}`,
	);
	await expect(
		page.getByRole("heading", { name: "Direct link fixture", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "Close", exact: true }).click();
	await expect(page).not.toHaveURL(/email=/);
	expect(new URL(page.url()).searchParams.get("q")).toBe("Direct");
	await page.goto(list + "&email=invalid");
	await expect(
		page.getByRole("heading", { name: "Direct link fixture", exact: true }),
	).toHaveCount(0);
});
