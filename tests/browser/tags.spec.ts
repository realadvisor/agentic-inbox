import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

test("create, edit, filter, apply/remove and bulk tag synthetic conversations", async ({
	page,
}) => {
	const db = connect();
	const store = new InboxStore(db);
	const mailbox = `tags-browser-${crypto.randomUUID()}@example.test`;
	const name = `Review ${crypto.randomUUID().slice(0, 8)}`;
	const renamed = `${name} renamed`;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	let tagId: string | undefined;
	try {
		await store.createMailbox(mailbox, "Conversation tag preview");
		const first = await store.insert(mailbox, {
			sender: "alex@example.test",
			recipient: mailbox,
			subject: "Synthetic privacy request",
			body: "<p>Please review my synthetic account request.</p>",
		});
		await store.insert(mailbox, {
			sender: "blair@example.test",
			recipient: mailbox,
			subject: "Synthetic viewing enquiry",
			body: "<p>Can we arrange a synthetic viewing?</p>",
		});
		await page.goto(`/mailbox/${mailbox}/settings`);
		await page.getByRole("button", { name: "New tag", exact: true }).click();
		await page.getByRole("textbox", { name: "Tag name" }).fill(name);
		await page.getByLabel("Tag color").fill("#16a34a");
		await page.getByRole("button", { name: "Save tag" }).click();
		await expect(page.getByText(name, { exact: true })).toBeVisible();
		tagId = (await db`SELECT id FROM tags WHERE name=${name}`)[0].id;
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Synthetic privacy request", { exact: true }).click();
		await page
			.getByRole("combobox", { name: "+ Tag", exact: true })
			.selectOption(tagId!);
		await page.getByRole("button", { name: "Apply tag", exact: true }).click();
		await expect(
			page.getByRole("button", { name: `Remove tag ${name}`, exact: true }),
		).toBeVisible();
		await page.reload();
		await page
			.getByRole("combobox", { name: "Tag filter", exact: true })
			.selectOption(tagId!);
		await expect(
			page.getByText("Synthetic viewing enquiry", { exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByText("Synthetic privacy request", { exact: true }),
		).toBeVisible();
		await store.insert(mailbox, {
			sender: "alex@example.test",
			recipient: mailbox,
			subject: "Synthetic follow-up",
			body: "More synthetic details",
			thread_id: first!.thread_id!,
		});
		await page.getByRole("button", { name: "Refresh", exact: true }).click();
		await expect(
			page.getByText("Synthetic follow-up", { exact: true }),
		).toBeVisible();
		await page.getByText("Synthetic follow-up", { exact: true }).click();
		await page
			.getByRole("button", { name: `Remove tag ${name}`, exact: true })
			.click();
		await expect(
			page.getByText("No conversations with this tag in this folder."),
		).toBeVisible();
		await page
			.getByRole("combobox", { name: "Tag filter", exact: true })
			.selectOption("");
		await page
			.getByRole("checkbox", { name: "Select all conversations on page" })
			.check();
		await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
		await page
			.getByRole("combobox", { name: "Tag for selected conversations" })
			.selectOption(tagId!);
		await page.getByRole("button", { name: "Add tag", exact: true }).click();
		await expect
			.poll(
				async () =>
					(await store.list(mailbox, { tag_id: tagId!, threaded: "true" }))
						.totalCount,
			)
			.toBe(2);
		await page
			.getByRole("combobox", { name: "Tag for selected conversations" })
			.selectOption(tagId!);
		await page.getByRole("button", { name: "Remove tag", exact: true }).click();
		await expect
			.poll(
				async () =>
					(await store.list(mailbox, { tag_id: tagId!, threaded: "true" }))
						.totalCount,
			)
			.toBe(0);
		await page
			.getByRole("combobox", { name: "Tag for selected conversations" })
			.selectOption(tagId!);
		await page.getByRole("button", { name: "Add tag", exact: true }).click();
		await expect
			.poll(
				async () =>
					(await store.list(mailbox, { tag_id: tagId!, threaded: "true" }))
						.totalCount,
			)
			.toBe(2);
		await page.goto(`/mailbox/${mailbox}/settings`);
		await page
			.getByRole("button", { name: `Edit tag ${name}`, exact: true })
			.click();
		await page.getByRole("textbox", { name: "Tag name" }).fill(renamed);
		await page.getByRole("button", { name: "Save tag" }).click();
		await expect(page.getByText(renamed, { exact: true })).toBeVisible();
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page
			.getByRole("combobox", { name: "Tag filter", exact: true })
			.selectOption(tagId!);
		await expect(
			page
				.getByRole("button")
				.filter({ hasText: "Synthetic follow-up" })
				.getByText(renamed, { exact: true }),
		).toBeVisible();
		await page.getByText("Synthetic follow-up", { exact: true }).click();
		await expect(
			page.getByRole("button", { name: `Remove tag ${renamed}` }),
		).toBeVisible();
		await page.screenshot({ path: ".local/tags-preview.png", fullPage: true });
		await page.setViewportSize({ width: 390, height: 844 });
		await expect(
			page.getByRole("button", { name: "Mailboxes", exact: true }),
		).not.toBeInViewport();
		await expect(
			page.getByRole("button", { name: `Remove tag ${renamed}` }),
		).toBeInViewport();
		await page.screenshot({
			path: ".local/tags-mobile-preview.png",
			animations: "disabled",
			fullPage: true,
		});
		await page.setViewportSize({ width: 1440, height: 1000 });
		await page.goto(`/mailbox/${mailbox}/settings`);
		page.once("dialog", (dialog) => dialog.dismiss());
		await page
			.getByRole("button", { name: `Delete tag ${renamed}`, exact: true })
			.click();
		await expect(page.getByText(renamed, { exact: true })).toBeVisible();
		page.once("dialog", (dialog) => dialog.accept());
		await page
			.getByRole("button", { name: `Delete tag ${renamed}`, exact: true })
			.click();
		await expect(page.getByText(renamed, { exact: true })).toHaveCount(0);
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await expect(page.getByText(renamed, { exact: true })).toHaveCount(0);
		expect((await store.list(mailbox, { threaded: "true" })).totalCount).toBe(
			2,
		);
		expect(errors).toEqual([]);
	} finally {
		await db`DELETE FROM tags WHERE name IN (${name}, ${renamed})`;
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});
