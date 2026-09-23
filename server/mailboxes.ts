import type { Database } from "./db";
export const mailboxes = {
	"privacy@ingest.realadvisor.com": {
		name: "Privacy",
		from: "privacy@realadvisor.com",
	},
	"info@ingest.realadvisor.com": { name: "Info", from: "info@realadvisor.com" },
} as const;
// Live identities are derived only from registered addresses on the ingest domain.
export function liveSender(address: string): string | undefined {
	const match =
		/^([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)@ingest\.realadvisor\.com$/.exec(
			address,
		);
	if (!match || match[1].includes("..")) return undefined;
	return `${match[1]}@realadvisor.com`;
}
export async function mailboxConfig(db: Database, address: string) {
	const from = liveSender(address);
	if (!from) return undefined;
	const [row] =
		await db`SELECT name FROM mailboxes WHERE id=${address} AND email=${address}`;
	return row ? { name: row.name as string, from } : undefined;
}
