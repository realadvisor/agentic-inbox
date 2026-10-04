import assert from "node:assert/strict";
import { test } from "node:test";
import { browserDatabase } from "../scripts/browser-environment";

test("browser fixtures only accept the dedicated local database without connection overrides", () => {
	const safe = "postgres://inbox:test@127.0.0.1:55452/inbox_browser_test";
	assert.equal(browserDatabase(safe), safe);
	for (const url of [
		undefined,
		"",
		"postgres://inbox:test@db.example/inbox_browser_test",
		"postgres://inbox:test@127.0.0.1/agentic_inbox_prototype",
		"postgres://inbox:test@127.0.0.1/inbox_browser_test?host=db.example",
		"postgres://inbox:test@127.0.0.1/inbox_browser_test#fragment",
		"https://127.0.0.1/inbox_browser_test",
	]) {
		assert.throws(() => browserDatabase(url));
	}
});
