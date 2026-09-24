import { readFile } from "node:fs/promises";
import type { Database } from "./db";

export async function migrate(db: Database) {
	for (const [version, filename] of [
		[1, "001_inbox.sql"],
		[2, "002_real_mail.sql"],
		[3, "003_mailbox_creation.sql"],
		[5, "005_conversation_tags.sql"],
		[6, "006_classifiers.sql"],
		[7, "007_classifier_outbox.sql"],
		[8, "008_classifier_examples.sql"],
		[9, "009_email_agent.sql"],
		[10, "010_classifier_provider_runs.sql"],
		[11, "011_agent_ui_messages.sql"],
		[12, "012_agent_model_catalog.sql"],
	] as const) {
		const ddl = await readFile(
			new URL(`../migrations/${filename}`, import.meta.url),
			"utf8",
		);
		await db.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(7342201)`;
			await tx`CREATE TABLE IF NOT EXISTS inbox_migrations (version integer PRIMARY KEY)`;
			const applied =
				await tx`SELECT version FROM inbox_migrations WHERE version = ${version}`;
			if (!applied.length) {
				await tx.unsafe(ddl);
				await tx`INSERT INTO inbox_migrations VALUES (${version})`;
			}
		});
	}
}
