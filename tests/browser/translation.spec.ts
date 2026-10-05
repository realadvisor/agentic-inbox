import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

test.use({ locale: "fr-CH" });
test("one-click translation uses browser language, caches toggles and remembers language choice", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		mailbox = `translation-${randomUUID()}@example.test`;
	let requests = 0;
	try {
		await store.createMailbox(mailbox, "Translation");
		await store.insert(mailbox, {
			sender: "person@example.test",
			recipient: mailbox,
			subject: "Translate this message",
			body: "<p>Hello from the original message.</p>",
		});
		await page.route("**/emails/*/translation", async (route) => {
			requests++;
			const { targetLanguage } = route.request().postDataJSON();
			await route.fulfill({
				json: {
					html:
						targetLanguage === "fr"
							? '<p style="color:rgb(120, 40, 80)">Bonjour ! &lt;script&gt;bad()&lt;/script&gt;</p>'
							: '<p style="color:rgb(120, 40, 80)">Hallo!</p>',
					text:
						targetLanguage === "fr"
							? "Bonjour ! <script>bad()</script>"
							: "Hallo!",
					targetLanguage,
				},
			});
		});
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Translate this message", { exact: true }).click();
		await expect(
			page.getByRole("combobox", { name: "Translation language" }),
		).toContainText("Français");
		expect(requests).toBe(0);
		await page.getByRole("button", { name: "Translate", exact: true }).click();
		const translated = page.getByRole("region", { name: "Translated email" });
		const translatedBody = translated.frameLocator("iframe").locator("body");
		await expect(translatedBody).toContainText(
			"Bonjour ! <script>bad()</script>",
		);
		await expect(translatedBody.locator("script:not([nonce])")).toHaveCount(0);
		await page
			.getByRole("button", { name: "Show original", exact: true })
			.click();
		await expect(
			page.frameLocator('iframe[title="Email content"]').locator("body"),
		).toContainText("Hello from the original message.");
		await page.getByRole("button", { name: "Translate", exact: true }).click();
		await expect(translatedBody).toContainText("Bonjour");
		await expect(translatedBody.locator("p")).toHaveCSS(
			"color",
			"rgb(120, 40, 80)",
		);
		expect(requests).toBe(1);
		await page.getByRole("combobox", { name: "Translation language" }).click();
		await page.getByRole("option", { name: "Deutsch", exact: true }).click();
		await expect(translatedBody).toContainText("Hallo!");
		expect(requests).toBe(2);
		await page.screenshot({ path: ".local/translation-desktop.png" });
		// Check the control's narrow layout independently of the app's desktop sidebar.
		await translated.locator("..").evaluate((element) => {
			element.style.width = "260px";
		});
		await translated
			.locator("..")
			.screenshot({ path: ".local/translation-narrow.png" });
		await page.reload();
		await expect(
			page.getByRole("combobox", { name: "Translation language" }),
		).toContainText("Deutsch");
		await expect(
			page.getByRole("button", { name: "Translate", exact: true }),
		).toBeVisible();
		expect(requests).toBe(2);
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});

test("failure keeps original visible, explicit retry works and translation does not leak to another message", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		mailbox = `translation-error-${randomUUID()}@example.test`;
	let requests = 0;
	try {
		await store.createMailbox(mailbox, "Translation errors");
		const first = await store.insert(mailbox, {
			sender: "first@example.test",
			recipient: mailbox,
			subject: "Thread translation",
			body: "<p>First original.</p>",
		});
		await store.insert(mailbox, {
			sender: "second@example.test",
			recipient: mailbox,
			subject: "Thread translation",
			body: "<p>Second original.</p>",
			thread_id: first!.thread_id!,
		});
		await page.route("**/emails/*/translation", async (route) => {
			requests++;
			if (requests === 1)
				return route.fulfill({
					status: 502,
					json: { error: "Translation unavailable." },
				});
			return route.fulfill({
				json: {
					text: "Traduction réussie.",
					html: "<p>Traduction réussie.</p>",
					targetLanguage: "fr",
				},
			});
		});
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Thread translation", { exact: true }).click();
		await page.getByRole("button", { name: /^F first@example\.test/ }).click();
		await page.getByRole("button", { name: "Translate", exact: true }).click();
		await expect(page.getByRole("alert")).toContainText(
			"Translation unavailable.",
		);
		await expect(page.locator('iframe[title="Email content"]')).toBeVisible();
		await page.getByRole("button", { name: "Retry translation" }).click();
		await expect(
			page
				.getByRole("region", { name: "Translated email" })
				.frameLocator("iframe")
				.locator("body"),
		).toContainText("Traduction réussie.");
		await page
			.getByRole("button", { name: "Collapse message" })
			.first()
			.click();
		await page.getByRole("button", { name: /^S second@example\.test/ }).click();
		await expect(
			page.getByRole("region", { name: "Translated email" }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Translate", exact: true }),
		).toBeVisible();
		expect(requests).toBe(2);
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});

test("a late translation never replaces a newly selected language", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		mailbox = `translation-race-${randomUUID()}@example.test`;
	let finishFrench: (() => void) | undefined;
	try {
		await store.createMailbox(mailbox, "Translation race");
		await store.insert(mailbox, {
			sender: "sender@example.test",
			recipient: mailbox,
			subject: "Slow translation",
			body: "<p>The original stays readable.</p>",
		});
		await page.route("**/emails/*/translation", async (route) => {
			const { targetLanguage } = route.request().postDataJSON();
			if (targetLanguage === "fr")
				await new Promise<void>((resolve) => {
					finishFrench = resolve;
				});
			await route
				.fulfill({
					json: {
						html:
							targetLanguage === "fr"
								? "<p>Réponse tardive.</p>"
								: "<p>Deutsche Übersetzung.</p>",
						text:
							targetLanguage === "fr"
								? "Réponse tardive."
								: "Deutsche Übersetzung.",
						targetLanguage,
					},
				})
				.catch(() => {});
		});
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Slow translation", { exact: true }).click();
		await page.getByRole("button", { name: "Translate", exact: true }).click();
		await expect(
			page.getByRole("status").filter({ hasText: "Translating…" }),
		).toHaveText("Translating…");
		await expect(
			page.frameLocator('iframe[title="Email content"]').locator("body"),
		).toContainText("The original stays readable.");
		await page.getByRole("combobox", { name: "Translation language" }).click();
		await page.getByRole("option", { name: "Deutsch", exact: true }).click();
		await expect(
			page
				.getByRole("region", { name: "Translated email" })
				.frameLocator("iframe")
				.locator("body"),
		).toContainText("Deutsche Übersetzung.");
		finishFrench?.();
		await expect(
			page
				.getByRole("region", { name: "Translated email" })
				.frameLocator("iframe")
				.locator("body"),
		).toContainText("Deutsche Übersetzung.");
	} finally {
		finishFrench?.();
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});

test("cancel keeps the original visible even when the translation returns later", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		mailbox = `translation-cancel-${randomUUID()}@example.test`;
	let finish: (() => void) | undefined;
	try {
		await store.createMailbox(mailbox, "Cancel translation");
		await store.insert(mailbox, {
			sender: "person@example.test",
			recipient: mailbox,
			subject: "Cancel translation",
			body: '<p style="font-family:Georgia;color:rgb(120, 40, 80)">Original stays.</p>',
		});
		await page.route("**/emails/*/translation", async (route) => {
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			await route
				.fulfill({
					json: {
						html: "<p>Bonjour</p>",
						text: "Bonjour",
						targetLanguage: "fr",
					},
				})
				.catch(() => {});
		});
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("Cancel translation", { exact: true }).last().click();
		await page.getByRole("button", { name: "Translate", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Cancel", exact: true }),
		).toBeVisible();
		await page.getByRole("button", { name: "Cancel", exact: true }).click();
		finish?.();
		await expect(
			page
				.getByRole("region", { name: "Original email" })
				.frameLocator("iframe")
				.locator("p"),
		).toHaveText("Original stays.");
		await expect(
			page.getByRole("region", { name: "Translated email" }),
		).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Translate", exact: true }),
		).toBeVisible();
	} finally {
		finish?.();
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});
