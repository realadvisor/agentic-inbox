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
	for (const [name, color] of [
		["Importance: High", "#dc2626"],
		["Urgency: Medium", "#ca8a04"],
		["Topic: Cancellation", "#2563eb"],
		["Privacy: Deletion", "#9333ea"],
	]) {
		const [tag] =
			await db`INSERT INTO tags(name,color) VALUES(${name},${color}) ON CONFLICT (lower(name)) WHERE group_id IS NULL AND archived_at IS NULL DO UPDATE SET color=EXCLUDED.color RETURNING id`;
		await db`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor) VALUES(${mailbox},${email!.thread_id!},${tag.id},'classifier','fixture')`;
	}
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

test("compact detail controls remain accessible on desktop and mobile", async ({
	page,
}) => {
	await page.goto(
		`${origin}/mailbox/${mailbox}/emails/all?status=all&email=${emailId}`,
	);
	const status = page.getByRole("region", { name: "Conversation status" });
	await expect(
		page.getByRole("button", { name: "Mark done", exact: true }),
	).toBeVisible();
	const row = page.getByRole("button").filter({
		has: page.getByRole("checkbox", {
			name: "Select conversation Direct link fixture",
		}),
	});
	const box = await row.boundingBox();
	const checkbox = await row.getByRole("checkbox").boundingBox();
	const star = await row
		.getByRole("button", { name: "Star conversation" })
		.boundingBox();
	expect(box && checkbox && star).toBeTruthy();
	expect(
		Math.abs(checkbox!.y + checkbox!.height / 2 - (box!.y + box!.height / 2)),
	).toBeLessThan(3);
	expect(
		Math.abs(star!.y + star!.height / 2 - (box!.y + box!.height / 2)),
	).toBeLessThan(3);
	expect(box!.height).toBeLessThan(140);
	for (const name of [
		"Importance: High",
		"Urgency: Medium",
		"Topic: Cancellation",
		"Privacy: Deletion",
	])
		await expect(row.getByText(name, { exact: true })).toBeVisible();
	const tags = page.getByLabel("Conversation tags", { exact: true });
	const rerun = page.getByRole("button", { name: "Reclassify", exact: true });
	await expect(rerun).toBeVisible();
	expect((await status.boundingBox())!.y).toBeLessThan(
		(await tags.boundingBox())!.y,
	);
	await page.screenshot({ path: "/tmp/compact-desktop.png" });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Mark done", exact: true }),
	).toBeVisible();
	await expect(rerun).toBeVisible();
	expect(
		await page.evaluate(() => document.documentElement.scrollWidth),
	).toBeLessThanOrEqual(390);
	await page.screenshot({ path: "/tmp/compact-mobile.png" });
});
