import { creditGuard } from "../../server/classification/provider-state";
import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connect } from "../../server/db";
import { migrate } from "../../server/migrate";
import { createApi } from "../../server/api";
import { InboxStore } from "../../server/store";
import { advanceBackfills } from "../../server/classification/backfills";
import { processJob } from "../../server/classification/queue";
const schema =
	"test_backfill_browser_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const mailbox = "backfill-browser@example.test";
let probeCalls = 0,
	probeFunded = false;
let server: ReturnType<typeof serve>, origin: string;
test.beforeAll(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	const store = new InboxStore(db);
	await store.createMailbox(mailbox, "History");
	await db`UPDATE classifiers SET enabled=false`;
	const [tag] =
		await db`INSERT INTO tags(name,color) VALUES('Needs a reply','#2563eb') RETURNING id`;
	await db`INSERT INTO classifiers(tag_id,question,enabled) VALUES(${tag.id},'Does the conversation need a reply?',true)`;
	for (let i = 0; i < 3; i++)
		await store.insert(mailbox, {
			sender: "person@example.test",
			recipient: mailbox,
			subject: "Historical request",
			body: "Please help me.",
			folder_id: "archive",
			date: new Date("2026-09-01T00:00:00Z"),
		});
	let app: ReturnType<typeof createApi>;
	server = serve({
		fetch: (r) => app.fetch(r),
		hostname: "127.0.0.1",
		port: 0,
	});
	await new Promise<void>((r) => server.on("listening", r));
	const address = server.address();
	if (!address || typeof address === "string") throw Error("Missing port");
	origin = "http://127.0.0.1:" + address.port;
	app = createApi(db, {
		readAttachment: async () => null,
		classifiersEnabled: true,
		jevKey: "test",
		jevTransport: async () => {
			probeCalls++;
			return probeFunded
				? Response.json({ answers: { match: { type: "noul", noul: 0.99 } } })
				: Response.json({}, { status: 402 });
		},
		origin,
	});
	app.get("*", serveStatic({ root: "./build/client" }));
	app.get("*", serveStatic({ path: "./build/client/index.html" }));
});
test.afterAll(async () => {
	if (server) await new Promise<void>((r) => server.close(() => r()));
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
test("start a historical backfill and see durable, grouped progress after reload", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto(`${origin}/mailbox/${mailbox}/settings?tab=runs`);
	await page.getByRole("button", { name: "Runs", exact: true }).click();
	await page
		.getByRole("button", { name: "Reprocess emails", exact: true })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("Missing or outdated results (recommended)", {
			exact: true,
		}),
	).toBeVisible();
	await expect(
		dialog.getByPlaceholder("All matching conversations"),
	).toHaveValue("");
	await expect(
		dialog.getByText("3 conversations selected.", { exact: false }),
	).toBeVisible();
	await dialog
		.getByRole("button", { name: "Start reprocessing", exact: true })
		.click();
	await expect(dialog).toHaveCount(0);
	await expect(
		page.getByText("Preparing selection", { exact: true }),
	).toBeVisible();
	await advanceBackfills(db);
	for (const job of await db`SELECT token FROM conversation_classifications WHERE run_id IS NOT NULL AND status='pending'`)
		await processJob(db, "test", job.token, async () =>
			Response.json({
				model: "jev-test",
				answers: { match: { type: "noul", noul: 0.99 } },
			}),
		);
	await page.reload();
	const progress = page.getByRole("region", {
		name: "Reprocessing progress",
		exact: true,
	});
	await expect(progress.getByText("Finished", { exact: true })).toBeVisible();
	await expect(progress.getByText("3 / 3 tag evaluations")).toBeVisible();
	await expect(progress.getByText("2 reused", { exact: false })).toBeVisible();
	await progress.getByText("Progress by tag", { exact: true }).click();
	await expect(progress.getByText("Needs a reply · v1")).toBeVisible();
	await page.screenshot({
		path: ".local/backfill-progress.png",
		fullPage: true,
	});
	expect(errors).toEqual([]);
});

test("credit pause banner survives reload and resume checks billing before clearing it", async ({
	page,
}) => {
	const [{ id }] =
		await db`SELECT id FROM classifiers WHERE question='Does the conversation need a reply?'`;
	const started = await fetch(`${origin}/api/v1/classification/backfills`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: origin },
		body: JSON.stringify({
			classifier_ids: [id],
			mailbox_ids: [mailbox],
			selection: "all",
		}),
	});
	expect(started.status).toBe(202);
	await advanceBackfills(db);
	await creditGuard(db, async () => Response.json({}, { status: 402 }))(
		"https://example.test",
	);
	await page.goto(`${origin}/mailbox/${mailbox}/settings?tab=runs`);
	await page.getByRole("button", { name: "Runs", exact: true }).click();
	const banner = page.getByRole("status", { name: "Jev processing paused" });
	await expect(banner).toBeVisible();
	await expect(
		page
			.getByRole("region", { name: "Reprocessing progress", exact: true })
			.getByText("Paused", { exact: true }),
	).toBeVisible();
	await page.screenshot({ path: ".local/credit-pause-ui.png", fullPage: true });
	await banner.getByRole("button", { name: "Resume processing" }).click();
	await expect(
		banner.getByText("Typesafe still reports insufficient credits.", {
			exact: false,
		}),
	).toBeVisible();
	expect(probeCalls).toBe(1);
	await page.reload();
	await expect(banner).toBeVisible();
	probeFunded = true;
	await banner.getByRole("button", { name: "Resume processing" }).click();
	await expect(banner).toHaveCount(0);
	expect(probeCalls).toBe(2);
});
