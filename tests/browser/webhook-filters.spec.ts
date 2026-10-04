import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

test("webhook tag filters can be configured, edited and toggled without losing settings", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		mailbox = `filter-browser-${crypto.randomUUID()}@example.test`;
	const names = [
		"Listing inquiry " + crypto.randomUUID(),
		"Spam " + crypto.randomUUID(),
	];
	let ids: string[] = [];
	try {
		await store.createMailbox(mailbox, "Webhook filters preview");
		const rows =
			await db`INSERT INTO tags(name,color) VALUES(${names[0]},'#2563eb'),(${names[1]},'#dc2626') RETURNING id,name`;
		ids = names.map(
			(name) => rows.find((row) => row.name === name)!.id as string,
		);
		await page.goto(`/mailbox/${mailbox}/settings?tab=webhooks`);
		await page.getByRole("button", { name: "Add endpoint" }).click();
		await page.getByLabel("Endpoint URL").fill("https://hooks.example.com/n8n");
		await expect(
			page.getByRole("button", { name: "Save endpoint" }),
		).toBeEnabled();
		await page.getByLabel("Include tags", { exact: true }).click();
		await page.getByRole("option", { name: names[0], exact: true }).click();
		await page.getByLabel("Exclude tags", { exact: true }).click();
		await page.getByRole("option", { name: names[1], exact: true }).click();
		await page.screenshot({
			path: test.info().outputPath("webhook-filter-settings.png"),
			fullPage: true,
		});
		await page.getByRole("button", { name: "Save endpoint" }).click();
		await expect(
			page.getByRole("button", { name: "Copy secret", exact: true }),
		).toBeVisible();
		const [saved] =
			await db`SELECT * FROM webhook_endpoints WHERE mailbox_id=${mailbox}`;
		expect(saved.events).toEqual(["conversation.classified"]);
		expect(saved.include_tag_ids).toEqual([ids[0]]);
		expect(saved.exclude_tag_ids).toEqual([ids[1]]);
		await page.reload();
		await page.getByRole("button", { name: "Disable", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Enable", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Enable", exact: true }).click();
		await page.getByRole("button", { name: "Edit", exact: true }).click();
		await expect(
			page.getByRole("button", {
				name: `Remove ${names[0]} from include tags`,
			}),
		).toBeVisible();
		await expect(
			page.getByRole("button", {
				name: `Remove ${names[1]} from exclude tags`,
			}),
		).toBeVisible();
		await page
			.getByRole("checkbox", { name: "Classification completed", exact: true })
			.uncheck();
		await page
			.getByRole("checkbox", { name: "Email received", exact: true })
			.check();
		await page.getByRole("button", { name: "Save endpoint" }).click();
		await expect(page.getByLabel("Endpoint URL")).toHaveCount(0);
		const [changed] =
			await db`SELECT * FROM webhook_endpoints WHERE id=${saved.id}`;
		expect(changed.include_tag_ids).toEqual([ids[0]]);
		expect(changed.exclude_tag_ids).toEqual([ids[1]]);
		expect(changed.events).toEqual(["email.received"]);
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		if (ids.length) await db`DELETE FROM tags WHERE id IN ${db(ids)}`;
		await db.end();
	}
});
