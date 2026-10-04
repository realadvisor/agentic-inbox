// This entry point is used only by Playwright against a dedicated test database.
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { browserDatabase } from "./browser-environment";
const db = connect(browserDatabase(process.env.DATABASE_URL));
try {
	await db`DROP SCHEMA public CASCADE`;
	await db`CREATE SCHEMA public`;
	await migrate(db);
} finally {
	await db.end();
}
await import("./seed");
await import("../server/index");
