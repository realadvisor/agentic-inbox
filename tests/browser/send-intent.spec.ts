import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db";
import { SenderStore } from "../../server/senders";
import { InboxStore } from "../../server/store";

// Synthetic mode has no server idempotency ledger. This adapter models the live
// endpoint's replay response; the Node regression exercises real sendReal + PG.
for (const mode of ["new", "reply", "forward", "draft"] as const) {
	test(`${mode} UI retries a lost response with the original key and payload`, async ({
		page,
	}) => {
		const db = connect();
		const store = new InboxStore(db);
		const senders = new SenderStore(db);
		const originalDefault = (await senders.configuration())
			.default_sender_identity_id;
		const mailbox = `send-intent-${randomUUID()}@example.test`;
		try {
			await store.createMailbox(mailbox, "Send intent browser fixture");
			if (mode === "new") await senders.setDefault(mailbox);
			const fixture = await store.insert(mailbox, {
				sender: mode === "draft" ? mailbox : "sender@example.test",
				sender_identity_id: mode === "draft" ? mailbox : undefined,
				recipient: mode === "draft" ? "recipient@example.test" : mailbox,
				subject: "Send intent fixture",
				body: "<p>Synthetic original body</p>",
				folder_id: mode === "draft" ? "draft" : "inbox",
				delivery_status: mode === "draft" ? "draft" : "received",
			});
			let original: { url: string; key: string; body: string } | undefined;
			let responseBody = "";
			let attempts = 0;
			await page.route(
				`**/api/v1/mailboxes/${mailbox}/emails**`,
				async (route) => {
					const req = route.request();
					if (req.method() !== "POST") return route.continue();
					const current = {
						url: req.url(),
						key: req.headers()["idempotency-key"],
						body: req.postData()!,
					};
					attempts++;
					if (!original) {
						original = current;
						const accepted = await route.fetch();
						expect(accepted.status(), await accepted.text()).toBe(201);
						responseBody = await accepted.text();
						return route.abort("failed");
					}
					expect(current).toEqual(original);
					await route.fulfill({
						status: 201,
						contentType: "application/json",
						body: responseBody,
					});
				},
			);
			await page.goto(
				`/mailbox/${mailbox}/emails/${mode === "draft" ? "draft" : "inbox"}`,
			);
			if (mode === "new")
				await page
					.getByRole("button", { name: "Compose", exact: true })
					.click();
			else {
				await page.getByText("Send intent fixture", { exact: true }).click();
				if (mode !== "draft")
					await page
						.getByRole("button", {
							name: mode === "reply" ? "Reply" : "Forward",
							exact: true,
						})
						.first()
						.click();
			}
			if (mode === "new" || mode === "forward") {
				await page
					.getByLabel("To", { exact: true })
					.fill("recipient@example.test");
				await page.getByLabel("To", { exact: true }).press("Enter");
			}
			if (mode === "new")
				await page
					.getByLabel("Subject", { exact: true })
					.fill("Send intent fixture");
			if (mode !== "draft") {
				await page.getByRole("combobox", { name: "From", exact: true }).click();
				await page
					.getByRole("option")
					.filter({ hasText: `<${mailbox}>` })
					.click();
			}
			if (mode !== "draft")
				await page
					.locator('[contenteditable="true"]')
					.fill("Synthetic outgoing text");
			const send = page
				.getByRole("button", { name: "Simulate send", exact: true })
				.first();
			await send.click();
			await expect(
				page.getByText(/Delivery is unconfirmed.*Failed to fetch/).first(),
			).toBeVisible();
			if (mode === "new") {
				await senders.setDefault("info@realadvisor.com");
				await page.getByRole("combobox", { name: "From", exact: true }).click();
				await page
					.getByRole("option", { name: /<info@realadvisor\.com>/ })
					.click();
				page.once("dialog", async (dialog) => {
					expect(dialog.message()).toContain("original sender");
					await dialog.dismiss();
				});
				await send.click();
				await expect(
					page
						.getByText(
							"Previous send is unresolved. Retry the original content or check the saved request before sending changed content.",
							{ exact: true },
						)
						.first(),
				).toBeVisible();
				expect(attempts).toBe(1);
				page.once("dialog", async (dialog) => {
					expect(dialog.message()).toContain("ORIGINAL content");
					await dialog.accept();
				});
				await send.click();
				await expect(
					page
						.getByText(
							"Previous message confirmed sent. Review Sent before submitting your changed message as a new composition.",
							{ exact: true },
						)
						.first(),
				).toBeVisible();
				expect(attempts).toBe(2);
				await page.getByRole("combobox", { name: "From", exact: true }).click();
				await page
					.getByRole("option")
					.filter({ hasText: `<${mailbox}>` })
					.click();
			}
			if (mode === "draft") {
				await page.reload();
			}
			if (mode === "reply") {
				await page
					.locator('[contenteditable="true"]')
					.fill("Changed after uncertain send");
				page.once("dialog", async (dialog) => {
					expect(dialog.message()).toContain("ORIGINAL content");
					await dialog.dismiss();
				});
				await send.click();
				await expect(
					page
						.getByText(
							"Previous send is unresolved. Retry the original content or check the saved request before sending changed content.",
							{ exact: true },
						)
						.first(),
				).toBeVisible();
				expect(attempts).toBe(1);
				await page
					.locator('[contenteditable="true"]')
					.fill("Synthetic outgoing text");
			}
			await send.click();
			await expect(
				page.getByText("Message submitted", { exact: true }).first(),
			).toBeVisible();
			expect(attempts).toBe(2);
			expect(JSON.parse(original!.body).sender_identity_id).toBe(mailbox);
			if (mode === "draft")
				expect(JSON.parse(original!.body).draft_id).toBe(fixture!.id);
			expect(original!.key).toMatch(/^[0-9a-f-]{36}$/);
			const [count] =
				await db`SELECT count(*)::int AS n FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='simulated'`;
			expect(count.n).toBe(1);
		} finally {
			await db`UPDATE inbox_settings SET default_sender_identity_id=${originalDefault} WHERE id`;
			await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
			await db`DELETE FROM sender_identities WHERE id=${mailbox}`;
			await db.end();
		}
	});
}
