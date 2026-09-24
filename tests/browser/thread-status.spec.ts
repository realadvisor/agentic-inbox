import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";
import { getThreadWorkflow } from "../../server/thread-status";

test("Open and Done views, persistence, reopening and incoming reply reopening", async ({
	page,
}) => {
	const db = connect();
	const store = new InboxStore(db);
	const mailbox = `status-browser-${randomUUID()}@example.test`;
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await store.createMailbox(mailbox, "Status browser test");
		const email = await store.insert(mailbox, {
			sender: "sophie@example.test",
			recipient: mailbox,
			subject: "Status prototype request",
			body: "<p>Please delete my synthetic account.</p>",
		});
		expect(email).toBeTruthy();
		const thread = email!.thread_id!;
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Status prototype request", { exact: true }).click();
		const panel = page.getByRole("region", {
			name: "Conversation status",
			exact: true,
		});
		await panel.getByRole("button", { name: "Mark done", exact: true }).click();
		await expect(
			panel.getByRole("button", { name: "Reopen", exact: true }),
		).toBeVisible();
		await expect(page.getByText("No open conversations.")).toBeVisible();
		await panel.getByRole("button", { name: "Reopen", exact: true }).click();
		await expect(
			panel.getByRole("button", { name: "Mark done", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Waiting conversations", exact: true }),
		).toHaveCount(0);
		await expect(
			panel.getByRole("button", { name: "Wait", exact: true }),
		).toHaveCount(0);
		await panel.getByRole("button", { name: "Mark done", exact: true }).click();
		await page
			.getByRole("button", { name: "Done conversations", exact: true })
			.click();
		await page.reload();
		await page.getByText("Status prototype request", { exact: true }).click();
		await panel.getByRole("button", { name: "Status information" }).hover();
		await expect(
			page.getByRole("list", { name: "Status history" }),
		).toContainText("Open → Done");
		await page.keyboard.press("Escape");
		await expect(
			panel.getByRole("button", { name: "Reopen", exact: true }),
		).toBeVisible();
		await store.insert(mailbox, {
			sender: "sophie@example.test",
			recipient: mailbox,
			subject: "Status prototype request",
			body: "<p>One more question.</p>",
			thread_id: thread,
		});
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Status prototype request", { exact: true }).click();
		await expect(
			panel.getByRole("button", { name: "Mark done", exact: true }),
		).toBeVisible();
		await panel.getByRole("button", { name: "Status information" }).focus();
		await expect(
			page.getByRole("list", { name: "Status history" }),
		).toContainText("New incoming message");
		await page.keyboard.press("Escape");
		await expect(
			page.getByRole("list", { name: "Status history" }),
		).not.toBeVisible();
		expect((await getThreadWorkflow(db, mailbox, thread)).status).toBe("open");
		expect(errors).toEqual([]);
		await page.screenshot({
			path: ".local/thread-status-desktop.png",
			fullPage: true,
			animations: "disabled",
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await panel.getByRole("button", { name: "Status information" }).click();
		await expect(
			page.getByRole("list", { name: "Status history" }),
		).toContainText("New incoming message");
		await page.keyboard.press("Escape");
		await expect(
			panel.getByRole("button", { name: "Mark done", exact: true }),
		).toBeVisible();
		await expect(
			panel.getByRole("button", { name: "Wait", exact: true }),
		).toHaveCount(0);
		await page.screenshot({
			path: ".local/thread-status-mobile.png",
			fullPage: true,
			animations: "disabled",
		});
	} finally {
		await db`DELETE FROM mailboxes WHERE id = ${mailbox}`;
		await db.end();
	}
});
