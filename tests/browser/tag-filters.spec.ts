import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";
import { setConversationTags } from "../../server/tags";
test("combine tag filters, switch all/any and restore selection from URL", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		mailbox = `filters-${crypto.randomUUID()}@example.test`;
	const ids = [crypto.randomUUID(), crypto.randomUUID()];
	try {
		await store.createMailbox(mailbox, "Filter test");
		for (const [i, id] of ids.entries())
			await db`INSERT INTO tags(id,name,color) VALUES(${id},${`Filter ${id}`},'#2563eb')`;
		const first = await store.insert(mailbox, {
			sender: "a@example.test",
			recipient: mailbox,
			subject: "Both filter tags",
			body: "Synthetic",
		});
		const second = await store.insert(mailbox, {
			sender: "b@example.test",
			recipient: mailbox,
			subject: "One filter tag",
			body: "Synthetic",
		});
		await setConversationTags(
			db,
			mailbox,
			[first!.thread_id!, second!.thread_id!],
			ids[0],
			"add",
			"test",
		);
		await setConversationTags(
			db,
			mailbox,
			[first!.thread_id!],
			ids[1],
			"add",
			"test",
		);
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByRole("button", { name: "Tag filter", exact: true }).click();
		for (const id of ids)
			await page
				.getByRole("button", { name: `Choose tag Filter ${id}`, exact: true })
				.click();
		await expect(
			page.getByRole("button", {
				name: `Choose tag Filter ${ids[0]}`,
				exact: true,
			}),
		).toHaveAttribute("aria-pressed", "true");
		await page.getByRole("button", { name: "Done", exact: true }).click();
		await expect(
			page.getByText("Both filter tags", { exact: true }),
		).toBeVisible();
		await expect(page.getByText("One filter tag", { exact: true })).toHaveCount(
			0,
		);
		await page.getByLabel("Tag matching").selectOption("any");
		await expect(
			page.getByText("One filter tag", { exact: true }),
		).toBeVisible();
		await page.reload();
		await expect(page.getByLabel("Tag matching")).toHaveValue("any");
		await expect(
			page.getByRole("button", { name: "Tag filter", exact: true }),
		).toHaveText("Tags");
		await page
			.getByRole("button", {
				name: `Remove tag filter Filter ${ids[0]}`,
				exact: true,
			})
			.click();
		await expect(page.getByText("One filter tag", { exact: true })).toHaveCount(
			0,
		);
		await expect(page.getByLabel("Tag matching")).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Tag filter", exact: true }),
		).toHaveText("Tags");
		await page.getByRole("button", { name: "Tag filter", exact: true }).click();
		await page
			.getByRole("button", { name: "All conversations", exact: true })
			.click();
		await expect(
			page.getByText("One filter tag", { exact: true }),
		).toBeVisible();
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db`DELETE FROM tags WHERE id IN ${db(ids)}`;
		await db.end();
	}
});
