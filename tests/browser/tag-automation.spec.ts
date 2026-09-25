import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

test("Tags owns existing Jev settings and historical processing stays explicit", async ({
	page,
}) => {
	const db = connect();
	const store = new InboxStore(db);
	const mailbox = `automation-${crypto.randomUUID()}@example.test`;
	const name = `Follow up ${crypto.randomUUID().slice(0, 8)}`;
	let tagId: string | undefined;
	try {
		await store.createMailbox(mailbox, "Automation test");
		await store.insert(mailbox, {
			sender: "sender@example.test",
			recipient: mailbox,
			subject: "Existing conversation",
			body: "Please reply.",
		});
		const [tag] =
			await db`INSERT INTO tags(name,color) VALUES(${name},'#2563eb') RETURNING id`;
		tagId = String(tag.id);
		const question = "Does this conversation need a follow-up from our team?";
		const [classifier] =
			await db`INSERT INTO classifiers(tag_id,question,enabled,mailbox_ids,include_reviewed_examples) VALUES(${tagId},${question},false,ARRAY[${mailbox}],true) RETURNING id`;
		await page.goto(`/mailbox/${mailbox}/settings?tab=classifiers`);
		await expect(
			page.getByRole("button", { name: "Classifiers", exact: true }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Runs", exact: true }),
		).toBeVisible();
		const row = page.getByRole("button", {
			name: `Edit tag ${name}`,
			exact: true,
		});
		await expect(row).toContainText("Manual");
		await row.click();
		const dialog = page.getByRole("dialog", { name: "Edit tag", exact: true });
		await expect(
			dialog.getByRole("textbox", { name: "Tag name", exact: true }),
		).toBeFocused();
		await expect(dialog.getByLabel("Instructions for Jev")).toHaveCount(0);
		await expect(
			dialog.getByRole("button", {
				name: "Reprocess conversations",
				exact: true,
			}),
		).toBeEnabled();
		await dialog
			.getByRole("checkbox", {
				name: "Assign automatically with Jev",
				exact: true,
			})
			.check();
		await expect(dialog.getByLabel("Instructions for Jev")).toHaveValue(
			question,
		);
		await dialog.getByText("More options", { exact: true }).click();
		await expect(
			dialog.getByRole("checkbox", {
				name: "Use recent human examples",
				exact: true,
			}),
		).toBeChecked();
		await expect(
			dialog.getByRole("checkbox", { name: "Automation test", exact: true }),
		).toBeChecked();
		await dialog
			.getByRole("checkbox", { name: "Automation test", exact: true })
			.uncheck();
		await expect(
			dialog.getByRole("button", { name: "Save tag", exact: true }),
		).toBeDisabled();
		await dialog
			.getByRole("checkbox", { name: "Automation test", exact: true })
			.check();
		await dialog.getByRole("button", { name: "Save tag", exact: true }).click();
		await expect(dialog).not.toBeVisible();
		const [saved] =
			await db`SELECT *,to_json(mailbox_ids) AS mailbox_ids FROM classifiers WHERE id=${classifier.id}`;
		expect(saved.enabled).toBe(true);
		expect(saved.question).toBe(question);
		expect(saved.include_reviewed_examples).toBe(true);
		expect(saved.mailbox_ids).toEqual([mailbox]);
		expect(
			await db`SELECT id FROM classifier_runs WHERE classifier_id=${classifier.id}`,
		).toHaveLength(0);
		await expect(row).toContainText("Automatic");
		await row.click();
		await dialog
			.getByRole("button", {
				name: "Reprocess conversations",
				exact: true,
			})
			.click();
		const run = page.getByRole("dialog", {
			name: "Run on existing conversations",
			exact: true,
		});
		await expect(
			run.getByRole("checkbox", { name: "Automation test", exact: true }),
		).toBeChecked();
		await run.getByRole("button", { name: "Date range", exact: true }).click();
		await page.getByRole("button", { name: "Go to the next month" }).click();
		const future = new Date();
		future.setDate(15);
		future.setMonth(future.getMonth() + 1);
		const futureDay = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-15`;
		await page
			.getByLabel("Date range calendar")
			.locator(`[data-day="${futureDay}"] button`)
			.first()
			.click();
		await page
			.getByRole("button", { name: "Apply dates", exact: true })
			.click();
		await expect(
			run.getByRole("status").filter({ hasText: /conversation/i }),
		).toContainText("0 conversations selected");
		await expect(
			run.getByRole("button", { name: "Start run", exact: true }),
		).toBeDisabled();
		await run.getByRole("button", { name: "Date range", exact: true }).click();
		await page.getByRole("button", { name: "All time", exact: true }).click();
		await page
			.getByRole("button", { name: "Apply dates", exact: true })
			.click();
		await run.getByRole("spinbutton").fill("1");
		await expect(
			run.getByRole("status").filter({ hasText: /conversation/i }),
		).toContainText("1 conversation selected");
		await run.getByRole("button", { name: "Start run", exact: true }).click();
		await expect(run).not.toBeVisible();
		await expect(dialog).toBeVisible();
		const runs =
			await db`SELECT id FROM classifier_runs WHERE classifier_id=${classifier.id}`;
		expect(runs).toHaveLength(1);
		const [afterRun] =
			await db`SELECT revision FROM classifiers WHERE id=${classifier.id}`;
		expect(afterRun.revision).toBe(saved.revision);
		await expect(
			dialog.getByRole("button", { name: "Cancel run", exact: true }),
		).toBeVisible({ timeout: 10000 });
		await dialog
			.getByRole("button", { name: "Cancel run", exact: true })
			.click();
		await expect
			.poll(async () => {
				const [r] =
					await db`SELECT status FROM classifier_runs WHERE id=${runs[0].id}`;
				return r.status;
			})
			.toBe("cancelled");
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		if (tagId) {
			await db`DELETE FROM classifier_runs WHERE classifier_id IN (SELECT id FROM classifiers WHERE tag_id=${tagId})`;
			await db`DELETE FROM classifiers WHERE tag_id=${tagId}`;
			await db`DELETE FROM tags WHERE id=${tagId}`;
		}
		await db.end();
	}
});
