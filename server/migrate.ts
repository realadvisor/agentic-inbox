import { readFile } from "node:fs/promises";
import type { Database } from "./db";

export async function migrate(db: Database) {
	const ddl = await readFile(
		new URL("../migrations/001_inbox.sql", import.meta.url),
		"utf8"
	);
	await db.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(7342201)`;
		await tx`CREATE TABLE IF NOT EXISTS inbox_migrations (version integer PRIMARY KEY)`;
		const applied =
			await tx`SELECT version FROM inbox_migrations WHERE version = 1`;
		if (!applied.length) {
			await tx.unsafe(ddl);
			await tx`INSERT INTO inbox_migrations VALUES (1)`;
		}
	});
}
