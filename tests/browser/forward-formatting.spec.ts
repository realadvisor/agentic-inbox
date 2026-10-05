import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";
import { splitForwardDocument } from "../../app/lib/forward-document";

for (const direct of [false, true]) {
	test(`forward preserves HTML outside the editor through draft reopen and ${direct ? "direct" : "composer"} send`, async ({
		page,
	}) => {
		const db = connect(),
			store = new InboxStore(db);
		const mailbox = `forward-style-${crypto.randomUUID()}@example.test`;
		try {
			await store.createMailbox(mailbox, "Forward style fixture");
			const source = (await store.insert(mailbox, {
				sender: "customer@example.test",
				recipient: mailbox,
				subject: "Styled offer",
				body: '<!DOCTYPE html><html><head><style>.offer{background:#123456;color:white;width:400px}.offer td{padding:24px}button{display:none}</style></head><body style="margin:12px" class="original"><table class="offer"><tr><td><h2>Original offer</h2><a href="https://example.test/offer">Read more</a><img src="https://example.test/logo.png" width="80" onerror="alert(1)"></td></tr></table><script>alert(1)</script></body></html>',
			}))!;
			await page.route("https://example.test/**", (route) => route.abort());
			await page.goto(`/mailbox/${mailbox}/emails/inbox?email=${source.id}`);
			await page
				.getByRole("button", { name: "Forward", exact: true })
				.first()
				.click();
			const composer = page.getByRole("region", { name: "Email composer" });
			const editor = composer.locator('[contenteditable="true"]');
			await expect(editor).not.toContainText("Original offer");
			const preview = composer.frameLocator('iframe[title="Email content"]');
			await expect(preview.locator("table.offer")).toHaveCSS(
				"background-color",
				"rgb(18, 52, 86)",
			);
			await expect(preview.locator("td")).toHaveCSS("padding", "24px");
			await expect(preview.locator("body")).toHaveClass("original");
			await editor.fill("My personal note");
			await composer.getByRole("button", { name: "Expand composer" }).click();
			await expect(editor).toContainText("My personal note");
			await expect(preview.locator("table.offer")).toHaveCSS("width", "400px");
			await composer
				.getByLabel("To", { exact: true })
				.fill("recipient@example.test");
			await composer.getByLabel("To", { exact: true }).press("Enter");
			await composer
				.getByRole("button", { name: "Save as Draft", exact: true })
				.click();
			await expect(
				page.getByText("Draft saved!", { exact: true }).first(),
			).toBeVisible();
			const [draft] =
				await db`SELECT * FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='draft'`;
			expect(splitForwardDocument(draft.body)?.note).toContain(
				"My personal note",
			);
			expect(draft.body).not.toMatch(/onerror|<script/i);
			await page.goto(`/mailbox/${mailbox}/emails/draft?email=${draft.id}`);
			await page
				.getByRole("button", { name: "Edit", exact: true })
				.first()
				.click();
			await expect(editor).toContainText("My personal note");
			await expect(editor).not.toContainText("Original offer");
			await expect(preview.locator("table.offer")).toHaveCSS(
				"background-color",
				"rgb(18, 52, 86)",
			);
			await editor.fill("Updated personal note");
			await composer
				.getByRole("button", { name: "Save as Draft", exact: true })
				.click();
			await expect
				.poll(
					async () =>
						(await db`SELECT body FROM emails WHERE id=${draft.id}`)[0].body,
				)
				.toContain("Updated personal note");
			await page.screenshot({
				path: test.info().outputPath("forward-preview.png"),
				fullPage: true,
			});
			if (direct)
				await page.goto(`/mailbox/${mailbox}/emails/draft?email=${draft.id}`);
			await (direct ? page : composer)
				.getByRole("button", { name: "Simulate send", exact: true })
				.first()
				.click();
			await expect
				.poll(
					async () =>
						(
							await db`SELECT count(*)::int n FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='simulated'`
						)[0].n,
				)
				.toBe(1);
			const [sent] =
				await db`SELECT * FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='simulated'`;
			expect(sent.body).toContain("Updated personal note");
			expect(sent.body).toContain('class="offer"');
			expect(sent.body).toContain('src="https://example.test/logo.png"');
			expect(sent.body).toContain('href="https://example.test/offer"');
			expect(sent.body).toContain("background:#123456");
			expect(sent.thread_id).toBe(source.thread_id);
			expect(sent.in_reply_to).toBeNull();
			expect((sent.body.match(/Original offer/g) || []).length).toBe(1);
		} finally {
			await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
			await db`DELETE FROM sender_identities WHERE id=${mailbox}`;
			await db.end();
		}
	});
}
