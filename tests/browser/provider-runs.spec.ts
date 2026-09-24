import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connect } from "../../server/db";
import { migrate } from "../../server/migrate";
import { createApi } from "../../server/api";
import { InboxStore } from "../../server/store";
import { processJob } from "../../server/classification/queue";

// Uses the built UI and an isolated schema. No Jev calls or email sending.
const schema = "test_runs_browser_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const mailbox = "browser-runs@example.test";
let server: ReturnType<typeof serve>, origin: string;
let calls = 0;
test.beforeAll(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	const store = new InboxStore(db);
	await store.createMailbox(mailbox, "Run logs");
	const classifiers =
		await db`UPDATE classifiers SET enabled=true WHERE tag_id IN (SELECT id FROM tags WHERE group_id IS NULL) RETURNING id`;
	for (const [index, subject] of [
		"Help with my account",
		"Provider failure",
	].entries()) {
		const thread = crypto.randomUUID();
		await store.insert(mailbox, {
			id: thread,
			thread_id: thread,
			sender: "customer@example.test",
			recipient: mailbox,
			subject,
			body: "<p>Please help with my account.</p>",
			date: new Date(),
		});
		const [job] =
			await db`SELECT token FROM conversation_classifications WHERE thread_id=${thread} AND classifier_id=${classifiers[0].id}`;
		await processJob(db, "fake-key", job.token, async (_url, init) => {
			calls++;
			if (index) return new Response("rate limited", { status: 429 });
			const request = JSON.parse(String(init?.body));
			return Response.json({
				model: "jev-test",
				answers: Object.fromEntries(
					Object.keys(request.questions).map((k) => [
						k,
						{ type: "noul", noul: 0.94 },
					]),
				),
			});
		});
	}
	await db`INSERT INTO classifier_provider_runs (mailbox_id,thread_id,subject,started_at,status,requested_model,request_body,response_body)
		SELECT mailbox_id,thread_id,subject,started_at - interval '1 hour','succeeded',requested_model,request_body,'{"older":true}' FROM classifier_provider_runs WHERE subject='Help with my account'`;
	let app: ReturnType<typeof createApi>;
	server = serve({
		fetch: (request) => app.fetch(request),
		hostname: "127.0.0.1",
		port: 0,
	});
	await new Promise<void>((resolve) => server.on("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw Error("Missing server address");
	origin = `http://127.0.0.1:${address.port}`;
	app = createApi(db, {
		readAttachment: async () => null,
		classifiersEnabled: true,
		origin,
	});
	app.get("*", serveStatic({ root: "./build/client" }));
	app.get("*", serveStatic({ path: "./build/client/index.html" }));
});
test.afterAll(async () => {
	if (server)
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	await db.end();
	await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
	await admin.end();
});

test("inspect requests and responses, filter failures, and open the conversation", async ({
	page,
	context,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await context.grantPermissions(["clipboard-read", "clipboard-write"], {
		origin,
	});
	await page.goto(`${origin}/mailbox/${mailbox}/settings`);
	await page.getByRole("button", { name: "Runs", exact: true }).click();
	await expect(
		page
			.locator("nav")
			.getByRole("link", { name: "Classifier runs", exact: true }),
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Classifier runs", exact: true }),
	).toBeVisible();
	const list = page.getByRole("region", { name: "Provider runs" });
	await expect(list.getByRole("button")).toHaveCount(3);
	await list
		.getByRole("button")
		.filter({ hasText: "Help with my account" })
		.first()
		.click();
	const detail = page.getByRole("complementary", { name: "Run details" });
	await expect(detail.getByText("94.0% yes")).toHaveCount(3);
	await detail.getByRole("tab", { name: "Request", exact: true }).click();
	await expect(detail.locator("pre")).toContainText(
		"Please help with my account.",
	);
	await expect(detail.locator("pre")).toContainText("q0");
	await detail.getByRole("button", { name: "Copy JSON" }).click();
	await expect(detail.getByRole("status")).toHaveText("Copied");
	await detail.getByRole("tab", { name: "Response", exact: true }).click();
	await expect(detail.locator("pre")).toContainText("jev-test");
	await page.screenshot({
		path: ".local/classifier-runs-desktop.png",
		fullPage: true,
		animations: "disabled",
	});
	await detail.getByRole("link", { name: "Open conversation" }).click();
	await expect(
		page.frameLocator("iframe").first().locator("body"),
	).toContainText("Please help");
	const conversationUrl = page.url();
	const trigger = page.getByRole("button", {
		name: "View classifier runs",
		exact: true,
	});
	await trigger.click();
	const drawer = page.getByRole("dialog", {
		name: "Classification",
		exact: true,
	});
	await expect(drawer).toBeVisible();
	await expect(drawer.getByText("94.0% yes")).toHaveCount(3);
	await expect(page).toHaveURL(conversationUrl);
	await drawer.getByRole("combobox", { name: "Run history" }).click();
	await page.getByRole("option").last().click();
	await drawer.getByRole("tab", { name: "Response", exact: true }).click();
	await expect(drawer.locator("pre")).toContainText('"older": true');
	await drawer.getByRole("combobox", { name: "Run history" }).click();
	await page.getByRole("option", { name: /^Latest ·/ }).click();

	await drawer.getByRole("tab", { name: "Request", exact: true }).click();
	await expect(drawer.locator("pre")).toContainText(
		"Please help with my account.",
	);
	await drawer.getByRole("tab", { name: "Response", exact: true }).click();
	await expect(drawer.locator("pre")).toContainText("jev-test");
	await page.screenshot({
		path: ".local/classifier-run-drawer-desktop.png",
		animations: "disabled",
	});
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(drawer).toBeVisible();
	const bounds = await drawer.boundingBox();
	expect(bounds?.width).toBeLessThanOrEqual(390);
	expect(bounds?.x).toBeGreaterThanOrEqual(0);
	await page.screenshot({
		path: ".local/classifier-run-drawer-mobile.png",
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await expect(drawer).not.toBeVisible();
	await expect(trigger).toBeFocused();
	await expect(page).toHaveURL(conversationUrl);
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.goto(`${origin}/mailbox/${mailbox}/settings?tab=runs`);
	await expect(list.getByRole("button")).toHaveCount(3);
	await page.getByRole("combobox", { name: "Status", exact: true }).click();
	await page.getByRole("option", { name: "Failed", exact: true }).click();
	await expect(list.getByRole("button")).toHaveCount(1);
	await list.getByRole("button").click();
	await detail.getByRole("tab", { name: "Response", exact: true }).click();
	await expect(detail.locator("pre")).toHaveText("rate limited");
	await page.getByRole("button", { name: "Date range", exact: true }).click();
	await page.getByRole("button", { name: "Today", exact: true }).click();
	await expect(page).toHaveURL(/from=/);
	await page.getByRole("button", { name: "Date range", exact: true }).click();
	await page.getByRole("button", { name: "All time", exact: true }).click();
	await expect(page).not.toHaveURL(/from=/);
	await list.getByRole("button").click();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect
		.poll(() =>
			page
				.locator("aside")
				.first()
				.evaluate((e) => e.getBoundingClientRect().right),
		)
		.toBeLessThanOrEqual(0);
	await detail.getByRole("tab", { name: "Request", exact: true }).click();
	await detail.getByRole("tab", { name: "Response", exact: true }).click();
	await page.getByRole("button", { name: "Date range", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Apply dates", exact: true }),
	).toBeVisible();
	await page.screenshot({
		path: ".local/classifier-runs-date-picker.png",
		fullPage: true,
		animations: "disabled",
	});
	await page.keyboard.press("Escape");
	await expect(detail).toBeVisible();
	await expect(
		detail.getByRole("tab", { name: "Request", exact: true }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await page.screenshot({
		path: ".local/classifier-runs-mobile.png",
		fullPage: true,
		animations: "disabled",
	});
	expect(errors).toEqual([]);
	expect(calls).toBe(2);
});

test("conversation drawer includes questions split across provider requests", async ({
	page,
}) => {
	const [original] =
		await db`SELECT id,thread_id FROM classifier_provider_runs WHERE subject='Help with my account' AND response_body <> '{"older":true}' ORDER BY started_at DESC LIMIT 1`;
	const [item] =
		await db`SELECT * FROM classifier_provider_run_items WHERE run_id=${original.id} LIMIT 1`;
	const splitId = crypto.randomUUID();
	await page.route("**/classification/provider-runs?*", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		const source = body.runs.find((r: { id: string }) => r.id === original.id);
		await route.fulfill({
			json: {
				...body,
				runs: [
					{
						...source,
						id: splitId,
						classifiers: [
							source.classifiers.find(
								(c: { classifier_id: string }) =>
									c.classifier_id === item.classifier_id,
							),
						],
					},
					...body.runs,
				],
			},
		});
	});
	await page.route(
		`**/classification/provider-runs/${splitId}`,
		async (route) => {
			const response = await page.request.get(
				`${origin}/api/v1/classification/provider-runs/${original.id}`,
			);
			const body = await response.json();
			const request = JSON.parse(body.request_body);
			request.questions[item.question_key].instructions +=
				"\n\nHistorical human-labeled examples (guidance only; classify the current state, never these examples):\n" +
				JSON.stringify([
					{
						conversation: {
							messages: [{ text: "Synthetic teaching conversation" }],
						},
						expected: true,
						explanation: "Confirmed label",
					},
				]);
			body.request_body = JSON.stringify(request);
			await route.fulfill({
				json: {
					...body,
					id: splitId,
					items: [
						body.items.find(
							(i: { classifier_id: string }) =>
								i.classifier_id === item.classifier_id,
						),
					],
					response_body: JSON.stringify({
						answers: { split_question: { type: "noul", noul: 0.94 } },
					}),
				},
			});
		},
	);
	await page.goto(`${origin}/mailbox/${mailbox}/emails/inbox`);
	await page.getByText("Help with my account", { exact: true }).click();
	await page
		.getByRole("button", { name: "View classifier runs", exact: true })
		.click();
	const drawer = page.getByRole("dialog", {
		name: "Classification",
		exact: true,
	});
	await expect(
		drawer.getByText("Latest results across 2 requests.", { exact: false }),
	).toBeVisible();
	await expect(drawer.getByText("94.0% yes")).toHaveCount(3);
	const details = drawer.getByRole("complementary", { name: "Run details" });
	await expect(details).toHaveCount(2);
	await details
		.first()
		.getByRole("tab", { name: "Request", exact: true })
		.click();
	const exampleSection = details
		.first()
		.getByRole("region", { name: "Examples sent to Jev" });
	await expect(exampleSection).toContainText("1 example");
	await expect(exampleSection).toContainText("Synthetic teaching conversation");

	await details
		.first()
		.getByRole("tab", { name: "Response", exact: true })
		.click();
	await expect(details.first().locator("pre")).toContainText("split_question");
	await details
		.last()
		.getByRole("tab", { name: "Response", exact: true })
		.click();
	await expect(details.last().locator("pre")).toContainText("jev-test");
});
