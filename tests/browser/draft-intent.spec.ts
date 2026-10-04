import { test, expect } from "@playwright/test";
import { connect } from "../../server/db";
import { InboxStore } from "../../server/store";

for (const mode of ["new", "reply", "reply-all", "forward"] as const) {
	for (const direct of [false, true]) {
		test(`${mode}: save/reopen/${direct ? "direct" : "composer"} send preserves intent`, async ({
			page,
		}) => {
			const db = connect(),
				store = new InboxStore(db);
			const mailbox = `intent-${crypto.randomUUID()}@example.test`;
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			try {
				await store.createMailbox(mailbox, "Draft intent fixture");
				const source = (await store.insert(mailbox, {
					sender: "customer@example.test",
					recipient: mailbox,
					cc: "colleague@example.test",
					subject: "Intent source",
					body: "<p>Synthetic source</p>",
					message_id: `<${crypto.randomUUID()}@external.test>`,
				}))!;
				await page.goto(`/mailbox/${mailbox}/emails/inbox?email=${source.id}`);
				if (mode === "new")
					await page
						.getByRole("button", { name: "Compose", exact: true })
						.click();
				else
					await page
						.getByRole("button", {
							name:
								mode === "reply-all"
									? "Reply All"
									: mode === "reply"
										? "Reply"
										: "Forward",
							exact: true,
						})
						.first()
						.click();
				const composer = page.getByRole("region", { name: "Email composer" });
				if (mode === "new" || mode === "forward") {
					await composer
						.getByLabel("To", { exact: true })
						.fill("recipient@example.test");
					await composer.getByLabel("To", { exact: true }).press("Enter");
				}
				if (mode === "new")
					await composer
						.getByLabel("Subject", { exact: true })
						.fill("New intent");
				await composer
					.getByRole("combobox", { name: "From", exact: true })
					.click();
				await page
					.getByRole("option")
					.filter({ hasText: `<${mailbox}>` })
					.click();
				await composer
					.locator('[contenteditable="true"]')
					.fill("Saved intent content");
				await composer
					.getByRole("button", { name: "Save as Draft", exact: true })
					.click();
				await expect
					.poll(
						async () =>
							(
								await db`SELECT count(*)::int n FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='draft'`
							)[0].n,
					)
					.toBe(1);
				const [saved] =
					await db`SELECT * FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='draft'`;
				expect(saved.draft_mode).toBe(mode);
				expect(saved.draft_source_id).toBe(mode === "new" ? null : source.id);
				expect(saved.in_reply_to).toBeNull();
				await page.goto(`/mailbox/${mailbox}/emails/draft?email=${saved.id}`);
				await page
					.getByRole("button", { name: "Edit", exact: true })
					.first()
					.click();
				await expect(
					composer.getByRole("combobox", { name: "From", exact: true }),
				).toContainText(mailbox);
				await composer
					.getByRole("button", { name: "Save as Draft", exact: true })
					.click();
				await expect(
					page.getByText("Draft saved!", { exact: true }).first(),
				).toBeVisible();
				if (direct)
					await page.goto(`/mailbox/${mailbox}/emails/draft?email=${saved.id}`);
				await (direct ? page : composer)
					.getByRole("button", { name: "Simulate send", exact: true })
					.first()
					.click();
				await expect
					.poll(
						async () =>
							(
								await db`SELECT count(*)::int n FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='simulated'`
							)[0].n,
					)
					.toBe(1);
				const [sent] =
					await db`SELECT * FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='simulated'`;
				const reply = mode === "reply" || mode === "reply-all";
				expect(sent.in_reply_to).toBe(reply ? source.message_id : null);
				expect(sent.thread_id === source.thread_id).toBe(reply);
				expect(sent.sender).toBe(mailbox);
				expect(sent.cc).toBe(
					mode === "reply-all" ? "colleague@example.test" : "",
				);
				await expect
					.poll(
						async () =>
							(
								await db`SELECT count(*)::int n FROM emails WHERE id=${saved.id}`
							)[0].n,
					)
					.toBe(0);
				expect(errors).toEqual([]);
			} finally {
				await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
				await db`DELETE FROM sender_identities WHERE id=${mailbox}`;
				await db.end();
			}
		});
	}
}

test("agent-created reply opens in modal and keeps reply intent through save and send", async ({
	page,
}) => {
	const { claimRun, createTools } = await import("../../server/agent/service");
	const db = connect(),
		store = new InboxStore(db);
	const mailbox = `agent-intent-${crypto.randomUUID()}@example.test`;
	try {
		await store.createMailbox(mailbox, "Agent draft intent fixture");
		const source = (await store.insert(mailbox, {
			sender: "customer@example.test",
			recipient: mailbox,
			subject: "Agent source",
			body: "Synthetic request",
		}))!;
		const run = {
			id: crypto.randomUUID(),
			mailbox,
			actor: "synthetic-browser-test",
			prompt: "Draft a synthetic reply",
		};
		await claimRun(db, run);
		// Explicit fixture calls only the deterministic tool, never an AI provider.
		await createTools(db, run, () => {}).draft_reply.execute!(
			{
				originalEmailId: source.id,
				body: "Synthetic agent reply",
				sender_identity_id: mailbox,
			},
			{ toolCallId: "synthetic-browser-fixture", messages: [] },
		);
		await db`UPDATE agent_turns SET status='complete' WHERE id=${run.id}`;
		await db`UPDATE agent_settings SET active_run=NULL,lease_until=NULL WHERE mailbox_id=${mailbox}`;
		const [draft] =
			await db`SELECT * FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='draft'`;
		expect(draft.draft_mode).toBe("reply");
		await page.goto(`/mailbox/${mailbox}/emails/inbox`);
		await page.getByRole("button", { name: "Agent", exact: true }).click();
		await page
			.getByRole("button", { name: "Review draft", exact: true })
			.click();
		const modal = page.getByRole("dialog");
		await expect(
			modal.getByRole("combobox", { name: "From", exact: true }),
		).toContainText(mailbox);
		await modal
			.getByRole("button", { name: "Save as Draft", exact: true })
			.click();
		await expect(
			page.getByText("Draft saved!", { exact: true }).first(),
		).toBeVisible();
		await modal
			.getByRole("button", { name: "Simulate send", exact: true })
			.click();
		await expect
			.poll(
				async () =>
					(
						await db`SELECT count(*)::int n FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='simulated'`
					)[0].n,
			)
			.toBe(1);
		const [sent] =
			await db`SELECT * FROM emails WHERE mailbox_id=${mailbox} AND delivery_status='simulated'`;
		expect(sent.in_reply_to).toBe(source.message_id);
		expect(sent.thread_id).toBe(source.thread_id);
		expect(sent.sender).toBe(mailbox);
	} finally {
		await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
		await db`DELETE FROM sender_identities WHERE id=${mailbox}`;
		await db.end();
	}
});

for (const mode of ["new", "reply", "reply-all", "forward"] as const) {
	test(`${mode}: direct-send retry in reopened composer retains exact endpoint, payload and key`, async ({
		page,
		context,
	}) => {
		const db = connect(),
			store = new InboxStore(db);
		const mailbox = `intent-retry-${crypto.randomUUID()}@example.test`;
		try {
			await store.createMailbox(mailbox, "Intent retry fixture");
			const source = (await store.insert(mailbox, {
				sender: "customer@example.test",
				recipient: mailbox,
				subject: "Retry source",
				body: "Source",
			}))!;
			const draft = (await store.insert(mailbox, {
				sender: mailbox,
				sender_identity_id: mailbox,
				recipient: "customer@example.test",
				subject: "Retry subject",
				body: "<p>First line</p><p>Second &amp; third</p>",
				delivery_status: "draft",
				folder_id: "draft",
				draft_mode: mode,
				draft_source_id: mode === "new" ? null : source.id,
				thread_id: source.thread_id!,
			}))!;
			const requests: {
				url: string;
				body: string | null;
				key: string | undefined;
			}[] = [];
			await context.route("**/api/v1/mailboxes/**", async (route) => {
				const request = route.request();
				if (
					request.method() === "POST" &&
					/\/(emails|reply|forward)$/.test(request.url())
				) {
					requests.push({
						url: request.url(),
						body: request.postData(),
						key: request.headers()["idempotency-key"],
					});
					if (requests.length === 1) await route.abort("failed");
					else
						await route.fulfill({
							status: 201,
							json: { id: crypto.randomUUID(), status: "simulated" },
						});
				} else await route.continue();
			});
			await page.goto(`/mailbox/${mailbox}/emails/draft?email=${draft.id}`);
			await page
				.getByRole("button", { name: "Simulate send", exact: true })
				.first()
				.click();
			await expect(
				page.getByText(/Delivery is unconfirmed/).first(),
			).toBeVisible();
			await page.reload();
			await page
				.getByRole("button", { name: "Edit", exact: true })
				.first()
				.click();
			await page
				.getByRole("region", { name: "Email composer" })
				.getByRole("button", { name: "Simulate send", exact: true })
				.click();
			await expect.poll(() => requests.length).toBe(2);
			expect(requests[1]).toEqual(requests[0]);
			expect(requests[0].key).toBeTruthy();
			expect(requests[0].url).toMatch(
				mode === "forward"
					? /\/forward$/
					: mode === "new"
						? /\/emails$/
						: /\/reply$/,
			);
		} finally {
			await db`DELETE FROM mailboxes WHERE id=${mailbox}`;
			await db`DELETE FROM sender_identities WHERE id=${mailbox}`;
			await db.end();
		}
	});
}
