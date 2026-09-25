import { AGENT_MODELS, DEFAULT_AGENT_MODEL } from "../../shared/agent";
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";
test("AI composer generates, previews replacement and protects text written during generation", async ({
	page,
}) => {
	const db = connect();
	const store = new InboxStore(db);
	const mailbox = `ai-${randomUUID()}@example.test`;
	let selectedModel = "";
	let delayNext = false;
	let finish: (() => void) | undefined;
	try {
		await store.createMailbox(mailbox, "AI composer test");
		await store.insert(mailbox, {
			sender: "sophie@example.test",
			recipient: mailbox,
			subject: "AI draft example",
			body: "What happens next?",
		});
		await page.route("**/agent/compose", async (route) => {
			if (route.request().method() === "GET") {
				await route.fulfill({
					json: {
						settings: {
							model: DEFAULT_AGENT_MODEL,
							system_prompt: "",
							auto_draft: false,
						},
						catalog: {
							models: AGENT_MODELS.map((m) => ({
								...m,
								provider: "workers",
								source: "workers",
								available: true,
								selectable: true,
								context_window: null,
								input_price: null,
								output_price: null,
							})),
							refreshed_at: null,
							gatewayConfigured: false,
						},
					},
				});
				return;
			}
			const input = route.request().postDataJSON();
			selectedModel = input.model;
			if (delayNext || input.instructions === "Slow response")
				await new Promise<void>((resolve) => {
					delayNext = false;
					finish = resolve;
				});
			await route.fulfill({
				json: {
					text:
						input.action === "shorten"
							? "Thanks. We will follow up."
							: "Hello Sophie,\n\nThank you for getting in touch.",
					model: "test-model",
				},
			});
		});
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByText("AI draft example", { exact: true }).click();
		await page
			.getByRole("button", { name: "Quick Draft", exact: true })
			.click();
		const composer = page.getByRole("region", {
			name: "Email composer",
			includeHidden: true,
		});
		const dialog = page.getByRole("dialog", { name: "Write with AI" });
		const customize = () =>
			composer.getByRole("button", { name: "Advanced" }).click();
		const editor = composer.locator('[contenteditable="true"]');
		await expect(editor).toContainText("Hello Sophie");
		await expect(editor.locator("p").nth(1)).toHaveCSS("margin-top", "15px");
		await editor.fill("Existing signature and notes.");
		await composer
			.getByRole("button", { name: "Quick Draft", exact: true })
			.click();
		await expect(editor).toContainText("Hello Sophie");
		await expect(editor).toContainText("Existing signature and notes.");
		await expect(dialog).toHaveCount(0);
		await editor.fill("Before the request.");
		delayNext = true;
		finish = undefined;
		await composer
			.getByRole("button", { name: "Quick Draft", exact: true })
			.click();
		await expect.poll(() => !!finish).toBe(true);
		await expect(composer.getByRole("status")).toHaveText(
			"Drafting your email…",
		);
		await editor.fill("Typed while Quick Draft was running.");
		finish!();
		await expect(editor).toContainText("Hello Sophie");
		await expect(editor).toContainText("Typed while Quick Draft was running.");
		await expect(composer.getByRole("status")).toHaveCount(0);
		await expect(dialog).toHaveCount(0);
		finish = undefined;

		await editor.fill("");
		await customize();
		await dialog.getByRole("button", { name: "Choose agent model" }).click();
		await expect(dialog.locator(".agent-model-menu")).toBeVisible();
		await expect
			.poll(() =>
				dialog.locator(".agent-model-footnote").evaluate((element) => {
					const bounds = element.getBoundingClientRect();
					return element.contains(
						document.elementFromPoint(
							bounds.x + bounds.width / 2,
							bounds.y + bounds.height / 2,
						),
					);
				}),
			)
			.toBe(true);
		await expect(dialog.locator(".agent-model-menu")).toHaveCSS("opacity", "1");
		await page.screenshot({ path: ".local/ai-model-dropdown.png" });
		await dialog.getByText("GLM 4.7 Flash", { exact: true }).click();
		await dialog
			.getByRole("button", { name: "Quick Draft", exact: true })
			.click();
		await expect(editor).toContainText("Hello Sophie");
		expect(selectedModel).toBe(AGENT_MODELS[1].id);
		await editor.fill("");
		await composer
			.getByRole("button", { name: "Quick Draft", exact: true })
			.click();
		await expect(editor).toContainText("Hello Sophie");
		await expect(dialog).toHaveCount(0);
		await editor.fill("My own draft.");
		await customize();
		await dialog.getByRole("button", { name: "Shorten", exact: true }).click();
		await expect(dialog.getByLabel("AI suggestion")).toContainText("Thanks.");
		await expect(editor).toContainText("My own draft.");
		await dialog
			.getByRole("button", { name: "Keep mine", exact: true })
			.click();
		await expect(dialog.getByLabel("AI suggestion")).toHaveCount(0);
		await dialog.getByRole("button", { name: "Shorten", exact: true }).click();
		await dialog
			.getByRole("button", { name: "Use suggestion", exact: true })
			.click();
		await expect(editor).toContainText("Thanks. We will follow up.");
		await editor.fill("");
		await customize();
		await dialog.getByLabel("AI instructions").fill("Slow response");
		await dialog
			.getByRole("button", { name: "Try again", exact: true })
			.click();
		await expect(
			dialog.getByRole("button", { name: "Drafting…", exact: true }),
		).toBeVisible();
		await dialog.getByRole("button", { name: "Close AI assistant" }).click();
		await editor.fill("Writing while the model works.");
		await expect.poll(() => !!finish).toBe(true);
		finish!();
		await expect(dialog.getByLabel("AI suggestion")).toContainText(
			"Hello Sophie",
		);
		await expect(editor).toContainText("Writing while the model works.");
		await page.screenshot({ path: ".local/ai-composer.png", fullPage: true });
		const [count] =
			await db`SELECT count(*)::int AS n FROM emails WHERE mailbox_id=${mailbox}`;
		expect(count.n).toBe(1);
		await dialog
			.getByRole("button", { name: "Keep mine", exact: true })
			.click();
		await page.unroute("**/agent/compose");
		await page.route("**/agent/compose", (route) =>
			route.fulfill({
				status: 503,
				json: {
					error: "Configure an AI provider in Settings to draft with AI.",
				},
			}),
		);
		await dialog
			.getByRole("button", { name: "Try again", exact: true })
			.click();
		await expect(dialog.getByRole("alert")).toContainText(
			"Configure an AI provider",
		);
		await expect(editor).toContainText("Writing while the model works.");
	} finally {
		finish?.();
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});
