import { connect } from "../server/db";
import { InboxStore } from "../server/store";
import { mailboxes } from "../server/mailboxes";
const db = connect();
try {
	const store = new InboxStore(db);
	for (const [email, config] of Object.entries(mailboxes)) {
		const [existing] = await db`SELECT id FROM mailboxes WHERE id=${email}`;
		if (!existing) await store.createMailbox(email, config.name);
	}
	console.log("Live mailboxes are ready. Synthetic mailboxes were preserved.");
} finally {
	await db.end();
}
