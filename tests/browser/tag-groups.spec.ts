import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";
import { setConversationTags } from "../../server/tags";

test("existing settings edit groups and conversation badges replace single selections", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db);
	const mailbox = `groups-browser-${crypto.randomUUID()}@example.test`;
	let groupId: string | undefined;
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	try {
		await store.createMailbox(mailbox, "Tag groups preview");
		const message = await store.insert(mailbox, {
			sender: "customer@example.test",
			recipient: mailbox,
			subject: "Review my request",
			body: "Please reply today.",
		});
		await page.goto(`/mailbox/${mailbox}/settings?tab=tags`);
		await expect(
			page.getByRole("button", { name: "Edit Urgency group" }),
		).toBeVisible();
		await page
			.getByRole("button", { name: "Add tag or group", exact: true })
			.click();
		await page
			.getByRole("button", {
				name: "Group Related tags, like Low, Medium, High",
				exact: true,
			})
			.click();
		const dialog = page.getByRole("dialog", {
			name: /New tag group|Edit Response priority/,
		});
		await expect(dialog.getByLabel("Group name")).toBeFocused();
		await dialog.getByLabel("Group name").fill("Response priority");
		await dialog.getByLabel("New tag name").fill("Low");
		await dialog.getByRole("button", { name: "Add", exact: true }).click();
		await dialog.getByLabel("New tag name").fill("High");
		await dialog.getByLabel("New tag name").press("Enter");
		await dialog.getByLabel("Assign automatically with Jev").check();
		await dialog
			.getByLabel("Instructions for Jev")
			.fill("High for action today, otherwise Low.");
		await dialog.getByRole("button", { name: "Save group" }).click();
		await expect(dialog).not.toBeVisible();
		const [group] =
			await db`SELECT id FROM tag_groups WHERE name='Response priority'`;
		groupId = String(group.id);
		await page.reload();
		await page
			.getByRole("button", { name: "Edit Response priority group" })
			.click();
		await expect(dialog.getByLabel("Instructions for Jev")).toHaveValue(
			"High for action today, otherwise Low.",
		);
		await expect(dialog.getByLabel("Group name")).toBeFocused();
		await dialog.getByLabel("Tag 1 name").fill("Normal");
		await expect(dialog.getByLabel("Tag 1 name")).toHaveValue("Normal");
		await dialog.getByRole("button", { name: "Save group" }).click();
		await expect(dialog).not.toBeVisible();
		await page
			.getByRole("button", {
				name: "Edit Response priority group",
				exact: true,
			})
			.click();
		await dialog
			.getByRole("button", {
				name: "Apply to existing conversations",
				exact: true,
			})
			.click();
		const runDialog = page.getByRole("dialog", {
			name: "Run on existing conversations",
			exact: true,
		});
		for (const checkbox of await runDialog.getByRole("checkbox").all()) {
			if (await checkbox.isChecked()) await checkbox.uncheck();
		}
		await runDialog.getByLabel("Tag groups preview", { exact: true }).check();
		await runDialog
			.getByRole("button", { name: "Start run", exact: true })
			.click();
		await expect(runDialog).not.toBeVisible();
		await expect(dialog).toBeVisible();
		const runs =
			await db`SELECT r.id FROM classifier_runs r JOIN classifiers c ON c.id=r.classifier_id JOIN tags t ON t.id=c.tag_id WHERE t.group_id=${groupId}`;
		expect(runs).toHaveLength(2);
		await expect(
			dialog.getByRole("button", { name: "Cancel run", exact: true }),
		).toBeVisible({ timeout: 10000 });
		await dialog
			.getByRole("button", { name: "Cancel run", exact: true })
			.click();
		await expect
			.poll(async () => {
				const rows =
					await db`SELECT r.id FROM classifier_runs r JOIN classifiers c ON c.id=r.classifier_id JOIN tags t ON t.id=c.tag_id WHERE t.group_id=${groupId!} AND r.status='running'`;
				return rows.length;
			})
			.toBe(0);
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		const tags =
			await db`SELECT id,name FROM tags WHERE group_id=${groupId} ORDER BY position`;
		await setConversationTags(
			db,
			mailbox,
			[message!.thread_id!],
			tags[1].id,
			"add",
			"tester",
		);
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Review my request", { exact: true }).click();
		await page
			.getByRole("button", { name: "Change Response priority" })
			.click();
		await page
			.getByRole("button", { name: "Choose tag Normal", exact: true })
			.click();
		await expect(
			page.getByRole("button", { name: "Change Response priority" }),
		).toContainText("Normal");
		const selected = await store.tagsForThreads(mailbox, [message!.thread_id!]);
		expect(selected).toHaveLength(1);
		expect(selected[0].name).toBe("Normal");
		await page.goto(`/mailbox/${mailbox}/settings?tab=tags`);
		await page
			.getByRole("button", { name: "Edit Response priority group" })
			.click();
		await dialog.getByLabel("Group name").fill("Unsaved");
		await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Edit Response priority group" }),
		).toBeVisible();
		await page.screenshot({
			path: ".local/groups-desktop.png",
			fullPage: true,
			animations: "disabled",
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await page
			.getByRole("button", { name: "Edit Response priority group" })
			.click();
		await expect(dialog).toHaveCSS("opacity", "1");
		await dialog
			.getByRole("button", { name: "Save group" })
			.scrollIntoViewIfNeeded();
		await expect(
			dialog.getByRole("button", { name: "Save group" }),
		).toBeInViewport();
		await page.screenshot({
			path: ".local/groups-mobile.png",
			fullPage: true,
			animations: "disabled",
		});
		expect(errors).toEqual([]);
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		if (groupId) {
			await db`DELETE FROM conversation_classifications WHERE classifier_id IN (SELECT c.id FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.group_id=${groupId})`;
			await db`DELETE FROM classifier_runs WHERE classifier_id IN (SELECT c.id FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.group_id=${groupId})`;
			await db`DELETE FROM classifiers WHERE tag_id IN (SELECT id FROM tags WHERE group_id=${groupId})`;
			await db`DELETE FROM tags WHERE group_id=${groupId}`;
			await db`DELETE FROM tag_groups WHERE id=${groupId}`;
		}
		await db.end();
	}
});
