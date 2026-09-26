import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

test("recipient suggestions support keyboard, click, exclusion and free entry", async ({
	page,
}) => {
	const db = connect();
	const store = new InboxStore(db);
	const mailbox = `recipients-${randomUUID()}@example.test`;
	try {
		await store.createMailbox(mailbox, "Recipient preview");
		for (const email of ["alice@example.test", "alex@example.test"])
			await store.insert(mailbox, {
				sender: email,
				recipient: mailbox,
				subject: "Hello",
				body: "Hello",
			});
		await db`UPDATE mailbox_contacts SET name='Alice Martin' WHERE mailbox_id=${mailbox} AND email='alice@example.test'`;
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByRole("button", { name: "Compose", exact: true }).click();
		const composer = page.getByRole("region", { name: "Email composer" });
		const to = composer.getByLabel("To", { exact: true });
		await to.fill("ali");
		const alice = page.getByRole("option", { name: /Alice Martin/ });
		await expect(alice).toBeVisible();
		await page.screenshot({ path: ".local/recipient-suggestions.png" });
		await page.setViewportSize({ width: 390, height: 844 });
		await expect
			.poll(() =>
				page
					.locator("aside")
					.evaluate((el) => el.getBoundingClientRect().right),
			)
			.toBeLessThanOrEqual(0);
		await expect(alice).toBeVisible();
		const bounds = await page.getByRole("listbox").boundingBox();
		expect(bounds!.x).toBeGreaterThanOrEqual(0);
		expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
		await page.screenshot({ path: ".local/recipient-suggestions-mobile.png" });
		await page.setViewportSize({ width: 1440, height: 1000 });
		await to.press("ArrowDown");
		await to.press("Enter");
		await expect(
			composer.getByRole("button", {
				name: "Remove alice@example.test from To",
			}),
		).toBeVisible();
		await expect(to).toHaveValue("");
		await composer.getByRole("button", { name: "Cc / Bcc" }).click();
		const cc = composer.getByLabel("Cc", { exact: true });
		await cc.fill("al");
		await expect(
			page.getByRole("option", { name: "alex@example.test", exact: true }),
		).toBeVisible();
		await expect(alice).not.toBeVisible();
		await page
			.getByRole("option", { name: "alex@example.test", exact: true })
			.click();
		await expect(
			composer.getByRole("button", {
				name: "Remove alex@example.test from Cc",
			}),
		).toBeVisible();
		const bcc = composer.getByLabel("Bcc", { exact: true });
		await bcc.fill("new@example.test");
		await bcc.press("Enter");
		await expect(
			composer.getByRole("button", {
				name: "Remove new@example.test from Bcc",
			}),
		).toBeVisible();
		await composer
			.getByRole("button", { name: "Remove alex@example.test from Cc" })
			.click();
		await cc.fill("alex");
		await expect(
			page.getByRole("option", { name: "alex@example.test", exact: true }),
		).toBeVisible();
		await cc.press("Escape");
		await expect(page.getByRole("listbox")).not.toBeVisible();
		await cc.fill("ale");
		await expect(
			page.getByRole("option", { name: "alex@example.test", exact: true }),
		).toBeVisible();
		await cc.press("ArrowDown");
		await cc.press("Tab");
		await expect(
			composer.getByRole("button", {
				name: "Remove alex@example.test from Cc",
			}),
		).toBeVisible();
		await expect(composer.getByRole("alert")).not.toBeVisible();
		await to.fill("invalid-address");
		await expect(composer.getByRole("alert")).not.toBeVisible();
		await to.press("Enter");
		await expect(to).toHaveValue("invalid-address");
		await expect(to).toHaveAttribute("aria-invalid", "true");
		await expect(to).toHaveCSS("text-decoration-line", "underline");
		await expect(composer.getByRole("alert")).toHaveText(
			"Enter a valid email address.",
		);
		await page.screenshot({ path: ".local/recipient-invalid.png" });
		await to.fill("valid@example.test");
		await expect(composer.getByRole("alert")).not.toBeVisible();
		await to.press("Enter");
		await page.route("**/recipients?**", (route) =>
			route.fulfill({
				status: 503,
				contentType: "application/json",
				body: '{"error":"Unavailable"}',
			}),
		);
		await to.fill("someone");
		await expect(
			page.getByText("Suggestions unavailable. You can still type an address."),
		).toBeVisible();
		await page.screenshot({ path: ".local/recipient-unavailable.png" });
		await to.fill("someone@example.test");
		await to.press("Enter");
		await expect(
			composer.getByRole("button", {
				name: "Remove someone@example.test from To",
			}),
		).toBeVisible();
		await expect(composer.getByRole("alert")).not.toBeVisible();
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});
