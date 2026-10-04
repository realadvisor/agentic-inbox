import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { connect } from "../../server/db";
import { migrate } from "../../server/migrate";
import { createApi } from "../../server/api";
import { InboxStore } from "../../server/store";
import { SenderStore } from "../../server/senders";

const schema = "reply_selection_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const mailbox = "privacy@ingest.realadvisor.com";
const allMailbox = "all@ingest.realadvisor.com";
let allReplyId: string;
let server: ReturnType<typeof serve>, origin: string;
let incomingId: string,
	outgoingId: string,
	sentOnlyId: string,
	draftOnlyId: string;

test.beforeAll(async () => {
	await admin.unsafe(`CREATE SCHEMA ${schema}`);
	await migrate(db);
	const store = new InboxStore(db);
	await store.createMailbox(mailbox, "Synthetic reply selection");
	await db`UPDATE classifiers SET enabled=false`;
	await store.createMailbox(allMailbox, "Synthetic All");
	await store.createMailbox("helpdesk@example.test", "Synthetic Helpdesk");
	await new SenderStore(db).save(
		{
			email: "support@example.test",
			name: "Support",
			mailbox_id: "helpdesk@example.test",
		},
		{},
	);
	const allReply = await store.insert(allMailbox, {
		sender: "customer@example.test",
		recipient:
			"PRIVACY@realadvisor.com, privacy@ingest.realadvisor.com, colleague@example.test",
		cc: "SUPPORT@example.test, HELPDESK@example.test, COLLEAGUE@example.test, outsider@realadvisor.com",
		subject: "Synthetic All reply",
		body: "Incoming All request",
		delivery_status: "received",
	});
	allReplyId = allReply!.id;

	const incoming = await store.insert(mailbox, {
		sender: "sender@example.test",
		recipient: `${mailbox}, PRIVACY@REALADVISOR.COM, colleague@example.test, COLLEAGUE@example.test`,
		cc: "COLLEAGUE@example.test, COPY@example.test, copy@example.test, PRIVACY@INGEST.REALADVISOR.COM, privacy@realadvisor.com, REPLY@example.test",
		subject: "Synthetic mixed thread",
		body: "Incoming request body",
		date: new Date("2026-01-02"),
	});
	incomingId = incoming!.id;
	await db`UPDATE emails SET reply_to='reply@example.test' WHERE id=${incomingId}`;
	await store.insert(mailbox, {
		sender: "older@example.test",
		recipient: mailbox,
		subject: "Older request",
		body: "Older request body",
		date: new Date("2026-01-01"),
		thread_id: incomingId,
	});
	const outgoing = await store.insert(mailbox, {
		sender: "PRIVACY@realadvisor.com",
		recipient: "sender@example.test",
		subject: "Synthetic mixed thread",
		body: "Outgoing response body",
		date: new Date("2026-01-03"),
		thread_id: incomingId,
		delivery_status: "sent",
		folder_id: "sent",
	});
	outgoingId = outgoing!.id;
	const sentOnly = await store.insert(mailbox, {
		sender: "privacy@realadvisor.com",
		recipient: "recipient@example.test",
		subject: "Synthetic outgoing only",
		body: "No received messages",
		delivery_status: "simulated",
		folder_id: "sent",
	});
	sentOnlyId = sentOnly!.id;
	const draft = await store.insert(mailbox, {
		sender: mailbox,
		recipient: "recipient@example.test",
		subject: "Synthetic draft only",
		body: "Draft body",
		delivery_status: "draft",
		folder_id: "draft",
	});
	draftOnlyId = draft!.id;
	let app: ReturnType<typeof createApi>;
	server = serve({
		fetch: (r) => app.fetch(r),
		hostname: "127.0.0.1",
		port: 0,
	});
	await new Promise<void>((resolve) => server.on("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw Error("No port");
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
		await new Promise<void>((resolve) => server.close(() => resolve()));
	await db.end();
	await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
	await admin.end();
});

test("toolbar and inline Reply target the newest incoming Reply-To after an outgoing public-address message", async ({
	page,
}) => {
	for (const index of [0, 1]) {
		await page.goto(
			`${origin}/mailbox/${mailbox}/emails/all?status=all&email=${outgoingId}`,
		);
		await expect(page.getByText("3 messages in this thread")).toBeVisible();
		await page
			.getByRole("button", { name: "Reply", exact: true })
			.nth(index)
			.click();
		await expect(
			page.getByRole("button", {
				name: "Remove reply@example.test from To",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: /Remove .* from To/ }),
		).toHaveCount(1);
		await expect(page.locator('[contenteditable="true"]')).not.toContainText(
			"Outgoing response body",
		);
	}
});

test("Reply All removes public/ingest self aliases and duplicate To/Cc recipients", async ({
	page,
}) => {
	await page.goto(
		`${origin}/mailbox/${mailbox}/emails/all?status=all&email=${outgoingId}`,
	);
	await expect(page.getByText("3 messages in this thread")).toBeVisible();
	await page.getByRole("button", { name: "Reply All", exact: true }).click();
	await expect(
		page.getByRole("button", {
			name: "Remove reply@example.test from To",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", {
			name: "Remove colleague@example.test from To",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Remove .* from To/ }),
	).toHaveCount(2);
	await expect(
		page.getByRole("button", {
			name: "Remove COPY@example.test from Cc",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: /Remove .* from Cc/ }),
	).toHaveCount(1);
});

test("outgoing-only and draft-only threads disable replies and hide reply AI shortcuts while keeping Forward", async ({
	page,
}) => {
	for (const id of [sentOnlyId, draftOnlyId]) {
		await page.goto(
			`${origin}/mailbox/${mailbox}/emails/all?status=all&email=${id}`,
		);
		await expect(
			page.getByRole("button", { name: "Reply", exact: true }),
		).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Reply All", exact: true }),
		).toBeDisabled();
		await expect(
			page.getByRole("button", { name: "Quick Draft", exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Advanced", exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Forward", exact: true }),
		).toBeEnabled();
	}
});

test("Reply All in All excludes registered senders and keeps recipients when choosing From", async ({
	page,
}) => {
	await page.goto(
		`${origin}/mailbox/${allMailbox}/emails/all?status=all&email=${allReplyId}`,
	);
	await page.getByRole("button", { name: "Reply All", exact: true }).click();
	const composer = page.getByRole("region", { name: "Email composer" });
	await expect(
		composer.getByRole("button", {
			name: "Remove customer@example.test from To",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		composer.getByRole("button", {
			name: "Remove colleague@example.test from To",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		composer.getByRole("button", { name: /Remove .* from To/ }),
	).toHaveCount(2);
	await expect(
		composer.getByRole("button", {
			name: "Remove outsider@realadvisor.com from Cc",
			exact: true,
		}),
	).toBeVisible();
	await expect(
		composer.getByRole("button", { name: /Remove .* from Cc/ }),
	).toHaveCount(1);
	await composer.getByRole("combobox", { name: "From", exact: true }).click();
	await page.getByRole("option", { name: /<support@example.test>/ }).click();
	await expect(
		composer.getByRole("combobox", { name: "From", exact: true }),
	).toContainText("support@example.test");
	await expect(
		composer.getByRole("button", { name: /Remove .* from To/ }),
	).toHaveCount(2);
	await expect(
		composer.getByRole("button", { name: /Remove .* from Cc/ }),
	).toHaveCount(1);
});
