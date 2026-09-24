import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

test("create, edit, filter, apply/remove and bulk tag synthetic conversations", async ({
	page,
}) => {
	const choose = async (label: string, tagName: string) => {
		await page.getByRole("button", { name: label, exact: true }).click();
		await page
			.getByRole("button", { name: `Choose tag ${tagName}`, exact: true })
			.click();
		if (label === "Tag filter")
			await page.getByRole("button", { name: "Done", exact: true }).click();
	};

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
		await page.goto(`/mailbox/${mailbox}/settings?tab=tags`);
		await page
			.getByRole("button", { name: "Add tag or group", exact: true })
			.click();
		await page
			.getByRole("button", {
				name: "Tag A label you can use on its own",
				exact: true,
			})
			.click();
		await page.getByRole("textbox", { name: "Tag name" }).fill(name);
		await page.getByLabel("Tag color").fill("#16a34a");
		await page.getByRole("button", { name: "Save tag" }).click();
		await expect(page.getByRole("textbox", { name: "Tag name" })).toHaveCount(
			0,
		);
		await expect(
			page.getByRole("main").getByText(name, { exact: true }),
		).toBeVisible();
		tagId = (await db`SELECT id FROM tags WHERE name=${name}`)[0].id;
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Synthetic privacy request", { exact: true }).click();
		await page.getByRole("button", { name: "+ Tag", exact: true }).click();
		await page.getByRole("textbox", { name: "Search tags" }).fill(name);
		await page
			.getByRole("button", { name: `Choose tag ${name}`, exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: `Remove tag ${name}`, exact: true }),
		).toBeVisible();
		await page.reload();
		await choose("Tag filter", name);
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
			page.getByText("No conversations matching these tags in this folder."),
		).toBeVisible();
		await page.getByRole("button", { name: "Tag filter", exact: true }).click();
		await page
			.getByRole("button", { name: "All conversations", exact: true })
			.click();
		await expect(
			page.getByRole("dialog", { name: "Filter by tag", exact: true }),
		).not.toBeVisible();
		await page
			.getByRole("checkbox", { name: "Select all conversations on page" })
			.check();
		await expect(page.getByText("2 selected", { exact: true })).toBeVisible();
		await choose("Tag for selected conversations", name);
		await page.getByRole("button", { name: "Add tag", exact: true }).click();
		await expect
			.poll(
				async () =>
					(await store.list(mailbox, { tag_id: tagId!, threaded: "true" }))
						.totalCount,
			)
			.toBe(2);
		await choose("Tag for selected conversations", name);
		await page.getByRole("button", { name: "Remove tag", exact: true }).click();
		await expect
			.poll(
				async () =>
					(await store.list(mailbox, { tag_id: tagId!, threaded: "true" }))
						.totalCount,
			)
			.toBe(0);
		await choose("Tag for selected conversations", name);
		await page.getByRole("button", { name: "Add tag", exact: true }).click();
		await expect
			.poll(
				async () =>
					(await store.list(mailbox, { tag_id: tagId!, threaded: "true" }))
						.totalCount,
			)
			.toBe(2);
		// Sidebar tags span folders, persist on reload, and clear on folder navigation.
		await db`UPDATE emails SET folder_id='archive' WHERE mailbox_id=${mailbox} AND thread_id=${first!.thread_id!}`;
		await page
			.getByRole("region", { name: "Tags", exact: true })
			.getByRole("link", { name, exact: true })
			.click();
		await expect(page).toHaveURL(new RegExp(`/emails/all\\?tag_ids=${tagId}`));
		await expect(
			page.getByRole("heading", { name, exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("Synthetic follow-up", { exact: true }),
		).toBeVisible();
		await expect(
			page.getByText("Synthetic viewing enquiry", { exact: true }),
		).toBeVisible();
		await page.reload();
		await expect(
			page
				.getByRole("region", { name: "Tags", exact: true })
				.getByRole("link", { name, exact: true }),
		).toHaveAttribute("aria-current", "page");
		await expect(
			page.getByText("Synthetic follow-up", { exact: true }),
		).toBeVisible();
		await page
			.getByRole("navigation")
			.getByRole("link", { name: /^Inbox/ })
			.click();
		await expect(page).toHaveURL(new RegExp(`/emails/inbox$`));
		await expect(
			page.getByText("Synthetic follow-up", { exact: true }),
		).toHaveCount(0);
		await db`UPDATE emails SET folder_id='inbox' WHERE mailbox_id=${mailbox} AND thread_id=${first!.thread_id!}`;
		await page.goto(`/mailbox/${mailbox}/settings?tab=tags`);
		await page
			.getByRole("button", { name: `Edit tag ${name}`, exact: true })
			.click();
		await page.getByRole("textbox", { name: "Tag name" }).fill(renamed);
		await page.getByRole("button", { name: "Save tag" }).click();
		await expect(page.getByRole("textbox", { name: "Tag name" })).toHaveCount(
			0,
		);
		await expect(
			page.getByRole("main").getByText(renamed, { exact: true }),
		).toBeVisible();
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await choose("Tag filter", renamed);
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
		await page.goto(`/mailbox/${mailbox}/settings?tab=tags`);
		await expect(
			page.getByRole("button", { name: `Delete tag ${renamed}`, exact: true }),
		).toHaveCount(0);
		await page
			.getByRole("button", { name: `Edit tag ${renamed}`, exact: true })
			.click();
		page.once("dialog", (dialog) => dialog.dismiss());
		await page
			.getByRole("button", { name: `Delete tag ${renamed}`, exact: true })
			.click();
		await expect(
			page
				.getByRole("dialog", { name: "Edit tag", exact: true })
				.getByLabel("Tag name"),
		).toHaveValue(renamed);
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
