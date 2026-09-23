import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const password = randomBytes(24).toString("hex");
try {
	await writeFile(
		".env",
		`DATABASE_URL=postgres://inbox:${password}@127.0.0.1:55439/agentic_inbox_prototype\nPOSTGRES_PASSWORD=${password}\nPORT=4311\n`,
		{ flag: "wx", mode: 0o600 },
	);
	console.log(
		"Created .env with generated local credentials. Start Postgres, then run pnpm db:migrate and pnpm db:seed.",
	);
} catch (error) {
	if (error.code !== "EEXIST") throw error;
	console.log(".env already exists; left unchanged.");
}
