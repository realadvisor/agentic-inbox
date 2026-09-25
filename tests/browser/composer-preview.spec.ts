import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

test("inline composer keeps text across expansion, edits recipients, saves and sends", async ({
	page,
}) => {
	const db = connect();
	const store = new InboxStore(db);
	const mailbox = `composer-${randomUUID()}@example.test`;
	try {
		await store.createMailbox(mailbox, "Composer test");
		await store.insert(mailbox, {
			sender: "sophie@example.test",
			recipient: mailbox,
			subject: "A question about my account",
			body: "<p>Could you confirm the next steps?</p>",
		});
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page
			.getByText("A question about my account", { exact: true })
			.click();
		await page
			.getByRole("button", { name: "Reply", exact: true })
			.first()
			.click();
		const composer = page.getByRole("region", { name: "Email composer" });
		const editor = composer.locator('[contenteditable="true"]');
		await expect(composer).toBeVisible();
		await expect(editor).not.toContainText("Could you confirm");
		await editor.fill("Hi Sophie, here are the next steps.");
		await composer.getByRole("button", { name: "Expand composer" }).click();
		await expect(editor).toContainText("Hi Sophie");
		await composer.getByRole("button", { name: "Collapse composer" }).click();
		await expect(editor).toContainText("Hi Sophie");
		await composer.getByRole("button", { name: "Cc / Bcc" }).click();
		await composer
			.getByLabel("Cc", { exact: true })
			.fill("colleague@example.test");
		await composer.getByLabel("Cc", { exact: true }).press("Enter");
		await expect(
			composer.getByRole("button", {
				name: "Remove colleague@example.test from Cc",
			}),
		).toBeVisible();
		await composer
			.getByRole("button", { name: "Formatting", exact: true })
			.click();
		await expect(
			composer.getByRole("button", { name: "Bold", exact: true }),
		).toBeVisible();
		await composer.getByText("Show quoted message", { exact: true }).click();
		await expect(composer).toContainText("Could you confirm the next steps?");
		await composer
			.getByRole("button", { name: "Save as Draft", exact: true })
			.click();
		await expect(
			page.getByText("Draft saved!", { exact: true }).first(),
		).toBeVisible();
		const [draft] =
			await db`SELECT body,cc FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='draft'`;
		expect(draft.body).toContain("Hi Sophie");
		expect(draft.body).toContain("Could you confirm");
		expect(draft.cc).toContain("colleague@example.test");
		await page.screenshot({
			path: ".local/composer-desktop.png",
			fullPage: true,
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await expect
			.poll(async () =>
				page
					.locator("aside")
					.evaluate((el) => el.getBoundingClientRect().right),
			)
			.toBeLessThanOrEqual(0);
		await composer.scrollIntoViewIfNeeded();
		await expect
			.poll(async () =>
				composer.evaluate((el) => el.getBoundingClientRect().left),
			)
			.toBeGreaterThanOrEqual(0);
		await expect(
			composer.getByRole("button", { name: "Simulate send", exact: true }),
		).toBeVisible();
		await page.screenshot({
			path: ".local/composer-mobile.png",
			fullPage: true,
		});
		await composer
			.getByRole("button", { name: "Simulate send", exact: true })
			.click();
		await expect(
			page.getByText("Message submitted", { exact: true }).first(),
		).toBeVisible();
		await expect(composer).not.toBeVisible();
		const [sent] =
			await db`SELECT body,cc FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='simulated'`;
		expect(sent.body).toContain("Hi Sophie");
		expect(sent.cc).toContain("colleague@example.test");
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});
