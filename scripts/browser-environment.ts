/** Destructive fixture setup is restricted to this disposable database name. */
export function browserDatabase(value: string | undefined) {
	if (!value) throw new Error("DATABASE_URL is required for browser tests.");
	const url = new URL(value);
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/inbox_browser_test" ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"Browser tests require a dedicated loopback inbox_browser_test database without URL options.",
		);
	}
	return url.href;
}
