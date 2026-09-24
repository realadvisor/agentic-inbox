import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { setConversationTags } from "../../server/tags";
import { InboxStore } from "../../server/store";
test("save and remove an example directly from the inbox conversation without changing tags", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		mailbox = `thread-example-${crypto.randomUUID()}@example.test`;
	let groupId: string | undefined;
	try {
		await store.createMailbox(mailbox, "Thread example");
		const email = await store.insert(mailbox, {
			sender: "customer@example.test",
			recipient: mailbox,
			subject: "Label directly from this thread",
			body: "<p>A synthetic conversation to label.</p>",
		});
		const created = await page.request.post("/api/v1/tag-groups", {
			data: {
				name: "Thread " + crypto.randomUUID(),
				selection: "single",
				instructions: "Assess impact.",
				enabled: false,
				tags: [
					{ id: crypto.randomUUID(), name: "Low", color: "#64748b" },
					{ id: crypto.randomUUID(), name: "High", color: "#dc2626" },
				],
			},
		});
		expect(created.ok()).toBe(true);
		const group = await created.json();
		groupId = group.id;
		await setConversationTags(
			db,
			mailbox,
			[email!.thread_id!],
			group.tags[1].id,
			"add",
			"test",
		);
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page
			.getByText("Label directly from this thread", { exact: true })
			.click();
		const url = page.url();
		await page
			.getByRole("button", { name: "Save as example", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Saved as example", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("region", { name: "Save conversation as example" }),
		).toHaveCount(0);

		const [saved] =
			await db`SELECT * FROM jev_examples WHERE mailbox_id=${mailbox}`;
		expect(saved.labels).toEqual([group.tags[1].id]);
		expect(saved.role).toBe("teach");
		expect(saved.thread_id).toBe(email!.thread_id);
		await page.reload();
		await page
			.getByText("Label directly from this thread", { exact: true })
			.click();
		const savedButton = page.getByRole("button", {
			name: "Saved as example",
			exact: true,
		});
		await expect(savedButton).toHaveAttribute("aria-pressed", "true");
		await savedButton.click();
		await expect(
			page.getByRole("button", { name: "Save as example", exact: true }),
		).toBeEnabled();
		expect(
			await db`SELECT id FROM jev_examples WHERE mailbox_id=${mailbox}`,
		).toHaveLength(0);
		expect(
			await db`SELECT tag_id FROM conversation_tags WHERE mailbox_id=${mailbox} AND removed_at IS NULL`,
		).toHaveLength(1);

		await page
			.getByRole("button", { name: `Change ${group.name}`, exact: true })
			.click();
		await page
			.getByRole("button", { name: "Choose tag Low", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: `Change ${group.name}`, exact: true }),
		).toContainText("Low");
		await page
			.getByRole("button", { name: "Save as example", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Saved as example", exact: true }),
		).toBeVisible();

		const rows =
			await db`SELECT * FROM jev_examples WHERE mailbox_id=${mailbox}`;
		expect(rows).toHaveLength(1);
		expect(rows[0].labels).toEqual([group.tags[0].id]);
		expect(rows[0].role).toBe("teach");
		expect(rows[0].state.messages).toEqual(saved.state.messages);
		expect(
			await db`SELECT * FROM conversation_tags WHERE mailbox_id=${mailbox}`,
		).toHaveLength(2);
		await expect(page).toHaveURL(url);
		await page.setViewportSize({ width: 390, height: 844 });
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		if (groupId) {
			await db`DELETE FROM classifiers WHERE tag_id IN (SELECT id FROM tags WHERE group_id=${groupId})`;
			await db`DELETE FROM tags WHERE group_id=${groupId}`;
			await db`DELETE FROM tag_groups WHERE id=${groupId}`;
		}
		await db.end();
	}
});
