import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

test("Choice review asks for one tag rather than separate yes/no answers", async ({
	page,
}) => {
	const db = connect();
	const mailbox = `choice-review-${crypto.randomUUID()}@example.test`;
	try {
		const store = new InboxStore(db);
		await store.createMailbox(mailbox, "Choice review");
		const email = await store.insert(mailbox, {
			sender: "test@example.test",
			recipient: mailbox,
			subject: "Review this choice",
			body: "Synthetic review fixture",
		});
		const group = crypto.randomUUID();
		const rows = ["Low", "Medium", "High"].map((name) => ({
			mailbox_id: mailbox,
			thread_id: email!.thread_id,
			classifier_id: crypto.randomUUID(),
			revision: 1,
			token: crypto.randomUUID(),
			answer: null,
			probability: 0.33,
			confidence: 0.42,
			source: "jev",
			status: "review",
			question: "Assess urgency",
			name,
			color: "#64748b",
			tag_id: crypto.randomUUID(),
			group_id: group,
			group_name: "Urgency",
			group_selection: "single",
			group_instructions: "Assess how soon action is needed.",
		}));
		let saved: unknown;
		let reviewed = false;
		await page.route("**/classification/results/**", async (route) => {
			if (route.request().method() === "PUT") {
				expect(route.request().url()).toContain(rows[2].classifier_id);
				saved = route.request().postDataJSON();
				reviewed = true;
				await route.fulfill({ status: 204 });
			} else await route.fulfill({ json: reviewed ? [] : rows });
		});
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page
			.getByRole("button", { name: "Needs review", exact: true })
			.click();
		const dialog = page.getByRole("dialog", { name: "Review classification" });
		await expect(dialog.getByText("Which tag is correct?")).toBeVisible();
		await expect(
			dialog.getByText("Assess how soon action is needed.", { exact: true }),
		).not.toBeVisible();
		await dialog.getByText("Show prompt", { exact: true }).click();
		await expect(
			dialog.getByText("Assess how soon action is needed.", { exact: true }),
		).toBeVisible();
		await page.setViewportSize({ width: 390, height: 320 });
		const layout = await dialog.evaluate((element) => ({
			height: element.getBoundingClientRect().height,
			overflow: getComputedStyle(element).overflowY,
			z: Number(getComputedStyle(element).zIndex),
			scrollable: element.scrollHeight > element.clientHeight,
		}));
		expect(layout.height).toBeLessThanOrEqual(288);
		expect(layout.overflow).toBe("auto");
		expect(layout.z).toBeGreaterThan(10);
		expect(layout.scrollable).toBe(true);
		await dialog
			.getByRole("button", { name: "Close", exact: true })
			.scrollIntoViewIfNeeded();
		await expect(
			dialog.getByRole("button", { name: "Close", exact: true }),
		).toBeInViewport();
		await page.setViewportSize({ width: 1280, height: 900 });

		await expect(dialog.getByText("Jev confidence: 42%")).toBeVisible();
		await expect(dialog.getByText("33%", { exact: true })).toHaveCount(3);
		await expect(
			dialog.getByRole("button", { name: "Yes", exact: true }),
		).toHaveCount(0);
		await expect(
			dialog.getByRole("button", { name: "No", exact: true }),
		).toHaveCount(0);
		await dialog.getByRole("button", { name: "High 33%", exact: true }).click();
		await expect(
			page.getByRole("button", { name: /^Needs review/ }),
		).toHaveCount(0);
		expect(saved).toEqual({ answer: true, revision: 1, token: rows[2].token });
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db.end();
	}
});
