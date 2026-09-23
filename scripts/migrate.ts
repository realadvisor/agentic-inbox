import { connect } from "../server/db";
import { migrate } from "../server/migrate";
const db = connect();
try {
	await migrate(db);
	console.log("Inbox schema is up to date.");
} finally {
	await db.end();
}
