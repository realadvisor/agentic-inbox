import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";

test("ordered-scale upgrade preserves the existing tag catalogue and classifier settings", async () => {
	const schema =
		"test_scale_upgrade_" + crypto.randomUUID().replaceAll("-", "");
	const admin = connect();
	const db = connect(process.env.DATABASE_URL, schema);
	try {
		await admin`CREATE SCHEMA ${admin(schema)}`;
		await db`CREATE TABLE inbox_migrations (version integer PRIMARY KEY)`;
		const directory = new URL("../migrations/", import.meta.url);
		for (const filename of (await readdir(directory)).sort()) {
			const version = Number(filename.slice(0, 3));
			if (!filename.endsWith(".sql") || version > 22) continue;
			await db.unsafe(await readFile(new URL(filename, directory), "utf8"));
			await db`INSERT INTO inbox_migrations VALUES (${version})`;
		}
		const snapshot = async () => ({
			tags: [...(await db`SELECT * FROM tags ORDER BY id`)],
			groups: [...(await db`SELECT * FROM tag_groups ORDER BY id`)],
			classifiers: [...(await db`SELECT * FROM classifiers ORDER BY id`)],
		});
		const before = await snapshot();
		assert.ok(before.tags.length > 0);
		assert.ok(before.groups.length > 0);
		await migrate(db);
		assert.deepEqual(await snapshot(), before);
		await migrate(db);
		assert.deepEqual(await snapshot(), before);
		const columns =
			await db`SELECT column_name FROM information_schema.columns WHERE table_schema=${schema} AND table_name='conversation_classifications' AND column_name IN ('score','confidence') ORDER BY column_name`;
		assert.deepEqual(
			columns.map((c) => c.column_name),
			["confidence", "score"],
		);
	} finally {
		await db.end();
		await admin`DROP SCHEMA IF EXISTS ${admin(schema)} CASCADE`;
		await admin.end();
	}
});
