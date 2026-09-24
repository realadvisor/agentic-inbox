import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";
test("reclassify from the message panel, show progress and remain on the conversation", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		mailbox = `rerun-ui-${crypto.randomUUID()}@example.test`;
	try {
		await store.createMailbox(mailbox, "Rerun browser");
		await store.insert(mailbox, {
			sender: "sender@example.test",
			recipient: mailbox,
			subject: "Reclassify this email",
			body: "Synthetic rerun test",
		});
		let polls = 0,
			requests = 0;
		await page.route("**/api/v1/classification/threads/**", async (route) => {
			if (route.request().method() === "POST") {
				requests++;
				await route.fulfill({ status: 202, json: { queued: 2, protected: 1 } });
			} else {
				polls++;
				await route.fulfill({
					json: {
						pending: polls === 1 ? 2 : 0,
						complete: polls === 1 ? 0 : 1,
						review: polls === 1 ? 0 : 1,
						failed: 0,
						skipped: 0,
					},
				});
			}
		});
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Reclassify this email", { exact: true }).click();
		const url = page.url();
		await page.getByRole("button", { name: "Reclassify", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Reclassifying…", exact: true }),
		).toBeDisabled();
		await expect(
			page.getByText(/Reclassification finished · 1 need review/),
		).toBeVisible();
		await expect(page.getByText(/Manual choices were preserved/)).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Reclassify", exact: true }),
		).toBeEnabled();
		await expect(page).toHaveURL(url);
		expect(requests).toBe(1);
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});
