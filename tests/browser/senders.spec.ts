import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";
import { SenderStore } from "../../server/senders";

test("All inbox replies retain their sender across draft saves and default changes", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		senders = new SenderStore(db);
	const all = `sender-browser-${crypto.randomUUID()}@example.test`;
	const info = "info@realadvisor.com",
		privacy = "privacy@realadvisor.com";
	const originalDefault = (await senders.configuration())
		.default_sender_identity_id;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await store.createMailbox(all, "Sender browser All");
		await senders.setDefault(info);
		const parent = await store.insert(all, {
			sender: "sender-test@example.test",
			recipient: privacy,
			subject: "Sender selection test",
			body: "<p>Please delete my data.</p>",
		});
		expect(parent).toBeTruthy();
		await page.goto(`/mailbox/${all}/emails/all`);
		await page.getByRole("button", { name: "Compose", exact: true }).click();
		await expect(
			page
				.getByRole("region", { name: "Email composer" })
				.getByRole("combobox", { name: "From", exact: true }),
		).toHaveValue(info);
		await page
			.getByRole("button", { name: "Close compose", exact: true })
			.click();
		await page.getByText("Sender selection test", { exact: true }).click();
		await page
			.getByRole("button", { name: "Reply", exact: true })
			.first()
			.click();
		const composer = page.getByRole("region", { name: "Email composer" });
		await expect(
			composer.getByRole("combobox", { name: "From", exact: true }),
		).toHaveValue(privacy);
		await composer
			.getByRole("combobox", { name: "From", exact: true })
			.selectOption(info);
		await composer
			.locator('[contenteditable="true"]')
			.fill("Testing sender persistence.");
		await composer
			.getByRole("button", { name: "Save as Draft", exact: true })
			.click();
		await expect
			.poll(async () => {
				const [row] =
					await db`SELECT sender FROM emails WHERE mailbox_id=${all} AND delivery_status='draft'`;
				return row?.sender;
			})
			.toBe(info);
		await page.goto(`/mailbox/${all}/settings?tab=senders`);
		await page
			.getByRole("combobox", { name: "Default sender", exact: true })
			.selectOption(privacy);
		await expect(
			page.getByRole("status").filter({ hasText: "Default sender saved." }),
		).toBeVisible();
		await page.goto(`/mailbox/${all}/emails/all`);
		await page.getByRole("button", { name: "Compose", exact: true }).click();
		await expect(
			page
				.getByRole("region", { name: "Email composer" })
				.getByRole("combobox", { name: "From", exact: true }),
		).toHaveValue(privacy);
		await page
			.getByRole("button", { name: "Close compose", exact: true })
			.click();
		const [draft] = await db<
			{ id: string }[]
		>`SELECT id FROM emails WHERE mailbox_id=${all} AND delivery_status='draft'`;
		await page.goto(`/mailbox/${all}/emails/draft?email=${draft.id}`);
		await page
			.getByText("Re: Sender selection test", { exact: true })
			.first()
			.click();
		// Draft messages expose Edit draft alongside the send action.
		await page
			.getByRole("button", { name: "Edit", exact: true })
			.first()
			.click();
		await expect(
			page
				.getByRole("region", { name: "Email composer" })
				.getByRole("combobox", { name: "From", exact: true }),
		).toHaveValue(info);
		await page
			.getByRole("region", { name: "Email composer" })
			.getByRole("combobox", { name: "From", exact: true })
			.selectOption(privacy);
		await page.screenshot({
			path: ".local/senders-preview.png",
			fullPage: true,
		});
		await page
			.getByRole("region", { name: "Email composer" })
			.getByRole("button", { name: "Simulate send", exact: true })
			.click();
		await expect
			.poll(async () => {
				const [row] =
					await db`SELECT sender FROM emails WHERE mailbox_id=${all} AND delivery_status='simulated'`;
				return row?.sender;
			})
			.toBe(privacy);
		const [sent] =
			await db`SELECT thread_id FROM emails WHERE mailbox_id=${all} AND delivery_status='simulated'`;
		expect(sent.thread_id).toBe(parent!.thread_id);
		expect(errors).toEqual([]);
	} finally {
		if (originalDefault) await senders.setDefault(originalDefault);
		await db`DELETE FROM mailboxes WHERE id=${all}`;
		await db`DELETE FROM sender_identities WHERE id=${all}`;
		await db.end();
	}
});
