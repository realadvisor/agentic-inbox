import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

for (const [composerSend, reply] of [
	[false, false],
	[true, false],
	[false, true],
	[true, true],
]) {
	test(`${composerSend ? "composer" : "direct draft"} ${reply ? "reply" : "new message"}: failed deletion stays successful and cleanup retries never send`, async ({
		page,
		context,
	}) => {
		const db = connect();
		const store = new InboxStore(db);
		const mailbox = `cleanup-${randomUUID()}@example.test`;
		try {
			await store.createMailbox(mailbox, "Cleanup regression");
			const parent = reply
				? await store.insert(mailbox, {
						sender: "synthetic@example.test",
						recipient: mailbox,
						subject: "Original question",
						body: "<p>Question</p>",
					})
				: undefined;
			const draft = await store.insert(mailbox, {
				sender: mailbox,
				sender_identity_id: mailbox,
				recipient: "synthetic@example.test",
				subject: "Cleanup regression",
				body: "<p>Keep this recoverable.</p>",
				draft_mode: parent ? "reply" : "new",
				draft_source_id: parent?.id,
				thread_id: parent?.thread_id ?? undefined,
				delivery_status: "draft",
				folder_id: "draft",
			});
			if (!draft) throw new Error("Draft fixture was not inserted");
			const url = `/mailbox/${mailbox}/emails/draft?email=${draft.id}`;
			let deletes = 0;
			let sends = 0;
			let failCleanup = true;
			await context.route("**/api/v1/mailboxes/**", async (route) => {
				const request = route.request();
				if (
					request.method() === "POST" &&
					/\/(emails|reply)$/.test(request.url())
				)
					sends++;
				if (
					request.method() === "DELETE" &&
					request.url().endsWith(`/${draft.id}`)
				) {
					deletes++;
					if (failCleanup) {
						await route.fulfill({
							status: 500,
							json: { error: "Injected cleanup failure" },
						});
						return;
					}
				}
				await route.continue();
			});
			const secondTab = await context.newPage();
			await secondTab.goto(url);
			await expect(
				secondTab
					.getByRole("button", { name: "Simulate send", exact: true })
					.first(),
			).toBeEnabled();
			await page.goto(url);
			await page
				.getByText("Cleanup regression", { exact: true })
				.first()
				.click();
			if (composerSend)
				await page
					.getByRole("button", { name: "Edit", exact: true })
					.first()
					.click();
			const composer = page.getByRole("region", { name: "Email composer" });
			await (composerSend ? composer : page)
				.getByRole("button", { name: "Simulate send", exact: true })
				.first()
				.click();
			await expect(
				page.getByText("Message submitted", { exact: true }).first(),
			).toBeVisible();
			await expect.poll(() => deletes).toBe(1);
			await expect(
				secondTab
					.getByRole("button", { name: "Simulate send", exact: true })
					.first(),
			).toBeDisabled();
			await expect(
				page.getByText("Injected cleanup failure", { exact: true }),
			).toHaveCount(0);
			await page.goto(url);
			await expect(
				page
					.getByRole("button", { name: "Simulate send", exact: true })
					.first(),
			).toBeDisabled();
			await expect(
				page.getByRole("button", { name: "Retry draft cleanup" }).first(),
			).toBeVisible();
			await page
				.getByRole("button", { name: "Edit", exact: true })
				.first()
				.click();
			await expect(
				composer.getByRole("button", { name: "Simulate send", exact: true }),
			).toBeDisabled();
			await expect(
				composer.getByRole("button", { name: "Save as Draft" }),
			).toBeDisabled();
			await composer
				.getByRole("button", { name: "Retry draft cleanup" })
				.click();
			await expect(
				composer.getByText(
					"Draft cleanup failed. You can retry cleanup safely.",
				),
			).toBeVisible();
			await secondTab.reload();
			await expect(
				secondTab
					.getByRole("button", { name: "Simulate send", exact: true })
					.first(),
			).toBeDisabled();
			failCleanup = false;
			await composer
				.getByRole("button", { name: "Retry draft cleanup" })
				.click();
			await expect
				.poll(
					async () =>
						(
							await db`SELECT count(*)::int n FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='draft'`
						)[0].n,
				)
				.toBe(0);
			await expect(
				composer.getByRole("button", { name: "Simulate send", exact: true }),
			).toBeDisabled();
			expect(sends).toBe(1);
			const [counts] =
				await db`SELECT count(*)::int n FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='simulated'`;
			expect(counts.n).toBe(1);
			await secondTab.close();
		} finally {
			await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
			await db`DELETE FROM sender_identities WHERE id=${mailbox}`;
			await db.end();
		}
	});
}

for (const composerSend of [false, true]) {
	test(`${composerSend ? "composer" : "direct draft"}: unconfirmed response preserves draft and never retries automatically`, async ({
		page,
	}) => {
		const db = connect();
		const store = new InboxStore(db);
		const mailbox = `uncertain-${randomUUID()}@example.test`;
		try {
			await store.createMailbox(mailbox, "Uncertain regression");
			const draft = await store.insert(mailbox, {
				sender: mailbox,
				sender_identity_id: mailbox,
				recipient: "synthetic@example.test",
				subject: "Uncertain regression",
				body: "<p>Preserve my draft.</p>",
				delivery_status: "draft",
				folder_id: "draft",
			});
			if (!draft) throw new Error("Draft fixture was not inserted");
			let sends = 0;
			let deletes = 0;
			await page.route("**/api/v1/mailboxes/**", async (route) => {
				if (route.request().method() === "DELETE") deletes++;
				if (
					route.request().method() === "POST" &&
					/\/emails$/.test(route.request().url())
				) {
					sends++;
					await route.fetch(); // The synthetic server accepts delivery; response is lost.
					await route.fulfill({
						status: 502,
						json: { error: "Injected lost response" },
					});
				} else await route.continue();
			});
			await page.goto(`/mailbox/${mailbox}/emails/draft?email=${draft.id}`);
			if (composerSend)
				await page
					.getByRole("button", { name: "Edit", exact: true })
					.first()
					.click();
			const composer = page.getByRole("region", { name: "Email composer" });
			await (composerSend ? composer : page)
				.getByRole("button", { name: "Simulate send", exact: true })
				.first()
				.click();
			await expect(
				page.getByText(/Delivery is unconfirmed/).first(),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Retry draft cleanup" }),
			).toHaveCount(0);
			await expect(
				page.getByText("Message submitted", { exact: true }),
			).toHaveCount(0);
			if (composerSend)
				await expect(
					composer.locator('[contenteditable="true"]'),
				).toContainText("Preserve my draft.");
			const [counts] =
				await db`SELECT count(*) FILTER (WHERE delivery_status='draft')::int drafts, count(*) FILTER (WHERE delivery_status='simulated')::int sent FROM emails WHERE mailbox_id=${mailbox}`;
			expect(counts).toMatchObject({ drafts: 1, sent: 1 });
			expect(sends).toBe(1);
			expect(deletes).toBe(0);
		} finally {
			await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
			await db`DELETE FROM sender_identities WHERE id=${mailbox}`;
			await db.end();
		}
	});
}
