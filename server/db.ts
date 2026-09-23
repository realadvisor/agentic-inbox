import postgres from "postgres";

export function connect(url = process.env.DATABASE_URL, schema = "public") {
	if (!url)
		throw new Error("DATABASE_URL is required. Run pnpm setup:local first.");
	return postgres(url, {
		max: 5,
		connection: { search_path: schema },
		onnotice: () => {},
	});
}
export type Database = ReturnType<typeof connect>;
