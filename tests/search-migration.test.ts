import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";

test("search migration recovers an invalid concurrent index and tolerates two runners", async () => {
	const schema = "search_migration_" + randomUUID().replaceAll("-", "");
	const root = connect();
	const db = connect(process.env.DATABASE_URL, schema);
	try {
		await root.unsafe(`CREATE SCHEMA ${schema}`);
		await migrate(db);
		const store = new InboxStore(db);
		const mailbox = "index@example.test";
		await store.createMailbox(mailbox, "Index test");
		for (let i = 0; i < 2; i++)
			await store.insert(mailbox, {
				sender: mailbox,
				recipient: mailbox,
				subject: "duplicate",
				body: "test",
			});
		await db`DROP INDEX CONCURRENTLY emails_substring_search`;
		await db`DELETE FROM inbox_migrations WHERE version=36`;
		await assert.rejects(
			db`CREATE UNIQUE INDEX CONCURRENTLY emails_substring_search ON emails(mailbox_id)`,
			{ code: "23505" },
		);
		const invalid =
			await db`SELECT indisvalid FROM pg_index WHERE indexrelid='emails_substring_search'::regclass`;
		assert.equal(invalid[0].indisvalid, false);
		await Promise.all([migrate(db), migrate(db)]);
		const [index] =
			await db`SELECT i.indisvalid,a.amname FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am a ON a.oid=c.relam WHERE i.indexrelid='emails_substring_search'::regclass`;
		assert.equal(index.indisvalid, true);
		assert.equal(index.amname, "gin");
		assert.equal(
			(await db`SELECT 1 FROM inbox_migrations WHERE version=36`).length,
			1,
		);
	} finally {
		await db.end();
		await root.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
		await root.end();
	}
});
