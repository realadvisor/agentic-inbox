import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { setConversationTags } from "../../server/tags";
import { InboxStore } from "../../server/store";
test("curate frozen examples, preview teaching context and run a held-out test set", async ({
	page,
}) => {
	const db = connect(),
		store = new InboxStore(db),
		mailbox = `examples-${crypto.randomUUID()}@example.test`,
		name = `Examples ${crypto.randomUUID().slice(0, 8)}`;
	let groupId: string | undefined;
	try {
		await store.createMailbox(mailbox, "Example browser fixture");
		const teach = await store.insert(mailbox, {
			sender: "sender@example.test",
			recipient: mailbox,
			subject: "Teaching fixture",
			body: "<p>Teaching evidence to read.</p>",
		});
		const held = await store.insert(mailbox, {
			sender: "sender@example.test",
			recipient: mailbox,
			subject: "Test fixture",
			body: "<p>Held-out evidence to read.</p>",
		});
		const created = await page.request.post("/api/v1/tag-groups", {
			data: {
				name,
				selection: "single",
				instructions: "Choose Low or High based on demonstrated impact.",
				enabled: false,
				tags: [
					{
						id: crypto.randomUUID(),
						name: "Low",
						color: "#64748b",
						description: "Low impact",
					},
					{
						id: crypto.randomUUID(),
						name: "High",
						color: "#dc2626",
						description: "High impact",
					},
				],
			},
		});
		expect(created.ok()).toBe(true);
		const group = await created.json();
		groupId = group.id;
		for (const email of [teach!, held!]) {
			await setConversationTags(
				db,
				mailbox,
				[email.thread_id!],
				group.tags[0].id,
				"add",
				"test",
			);
			const result = await page.request.post(
				"/api/v1/classification/examples/from-tags",
				{
					data: {
						mailbox_id: mailbox,
						thread_id: email.thread_id,
						tag_ids: [group.tags[0].id],
					},
				},
			);
			expect(result.ok()).toBe(true);
		}
		// Preview against the real local API; simulate predictions so browser checks never call Jev.
		await page.route("**/api/v1/classification/test", async (route) => {
			const body = route.request().postDataJSON();
			const response = await route.fetch({
				postData: JSON.stringify({ ...body, execute: false }),
			});
			const data = await response.json();
			if (body.execute)
				data.results = data.results.map((r: object, i: number) => ({
					...r,
					result: { answer: i === 0, probability: i === 0 ? 0.95 : 0.05 },
				}));
			await route.fulfill({ response, json: data });
		});
		await page.goto(`/mailbox/${mailbox}/settings?tab=tags`);
		await page
			.getByRole("button", { name: `Edit ${name} group`, exact: true })
			.click();
		const section = page.getByRole("region", { name: "Labeled examples" });
		await expect(
			section.getByRole("button", { name: "Add example", exact: true }),
		).toHaveCount(0);
		await expect(
			section.getByRole("link", { name: "Open inbox", exact: true }),
		).toHaveAttribute("href", `/mailbox/${mailbox}/emails/inbox`);
		await expect(section).toContainText("set the correct tags");
		await section
			.getByRole("button", { name: /Test fixture.*Low.*Teach Jev/ })
			.click();

		await section.getByLabel("Use this example").selectOption("test");
		await section
			.getByRole("button", { name: "Save example", exact: true })
			.click();
		await expect(section).toContainText("1 test cases");
		await section
			.getByRole("button", { name: "Run test set (1)", exact: true })
			.click();
		await expect(section.getByLabel("Example test results")).toContainText(
			"1/1 correct",
		);
		await section.getByText("View Jev requests", { exact: true }).click();
		const requests = section.getByLabel("Example test results").locator("pre");
		await expect(requests).toContainText("Teaching evidence to read.");
		await expect(requests).toContainText("Held-out evidence to read.");
		await db`UPDATE emails SET body='New content after labeling' WHERE thread_id=${teach!.thread_id!}`;
		await section
			.getByRole("button", { name: /Teaching fixture.*Low.*Teach Jev/ })
			.click();
		await expect(
			section.getByLabel("Example conversation", { exact: true }),
		).toContainText("Teaching evidence to read.");
		await expect(
			section.getByLabel("Example conversation", { exact: true }),
		).not.toContainText("New content");
		await section
			.getByRole("button", { name: "Cancel example", exact: true })
			.click();
		await page
			.getByLabel(/^Instructions for Jev/)
			.fill("Changed impact criteria.");
		await expect(section).toContainText("Needs label review");
		await expect(
			section.getByRole("button", { name: "Add example", exact: true }),
		).toHaveCount(0);
		await page.screenshot({ path: ".local/examples-desktop.png" });
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
