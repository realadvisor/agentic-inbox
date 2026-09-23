import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

test("browse, search, save and reopen a draft, and simulate a threaded reply", async ({
	page,
}) => {
	const db = connect();
	const store = new InboxStore(db);
	const mailbox = `browser-${randomUUID()}@example.test`;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await store.createMailbox(mailbox, "Browser test inbox");
		await store.insert(mailbox, {
			sender: "alex@example.test",
			recipient: mailbox,
			subject: "Synthetic deletion request",
			body: "<p>Please delete my synthetic account.</p>",
		});
		await page.goto("/");
		await expect(
			page.getByRole("heading", { name: "Mailboxes" })
		).toBeVisible();
		await page
			.getByRole("link")
			.filter({ hasText: "Browser test inbox" })
			.click();
		await expect(
			page.getByText("Synthetic deletion request", { exact: true })
		).toBeVisible();
		await page
			.getByRole("textbox", { name: "Search emails" })
			.fill("from:alex deletion");
		await page.getByRole("textbox", { name: "Search emails" }).press("Enter");
		await expect(
			page.getByText('1 result for "from:alex deletion"')
		).toBeVisible();
		await page.getByText("Synthetic deletion request", { exact: true }).click();
		await expect(page.frameLocator("iframe").locator("body")).toContainText(
			"Please delete my synthetic account."
		);
		await page
			.getByRole("button", { name: "Reply", exact: true })
			.first()
			.click();
		await page
			.locator('[contenteditable="true"]')
			.fill("Synthetic acknowledgement from the prototype.");
		await page
			.getByRole("button", { name: "Save as Draft", exact: true })
			.click();
		await expect(
			page.getByText("Draft saved!", { exact: true }).first()
		).toBeVisible();
		await page
			.getByRole("button", { name: "Save as Draft", exact: true })
			.click();
		await expect
			.poll(async () =>
				Number(
					(
						await db`SELECT count(*) AS n FROM emails WHERE mailbox_id = ${mailbox} AND folder_id = 'draft'`
					)[0].n
				)
			)
			.toBe(1);
		await page.goto(`/mailbox/${mailbox}/emails/draft`);
		await page
			.getByText("Re: Synthetic deletion request", { exact: true })
			.click();
		await page
			.getByRole("button", { name: "Edit", exact: true })
			.first()
			.click();
		await expect(page.locator('[contenteditable="true"]')).toContainText(
			"Synthetic acknowledgement"
		);
		await page
			.getByRole("button", { name: "Simulate send", exact: true })
			.first()
			.click();
		await expect(
			page
				.getByText("Message submitted", { exact: true })
				.first()
		).toBeVisible();
		await page.goto(`/mailbox/${mailbox}/emails/sent`);
		await expect(
			page.getByText("Re: Synthetic deletion request", { exact: true })
		).toBeVisible();
		const [counts] =
			await db`SELECT count(*) FILTER (WHERE delivery_status = 'simulated')::int AS sent, count(*) FILTER (WHERE delivery_status = 'draft')::int AS drafts, count(DISTINCT thread_id)::int AS threads FROM emails WHERE mailbox_id = ${mailbox}`;
		expect(counts).toMatchObject({ sent: 1, drafts: 0, threads: 1 });
		expect(errors).toEqual([]);
		await page.goto("/mailbox/privacy@realadvisor.com/emails/inbox");
		await expect(
			page.getByText("Request to delete my account", { exact: true })
		).toBeVisible();
		await page.screenshot({ path: ".local/inbox-preview.png", fullPage: true });
	} finally {
		await db`DELETE FROM mailboxes WHERE id = ${mailbox}`;
		await db.end();
	}
});
