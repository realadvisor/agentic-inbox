export const mailboxes = {
	"privacy@ingest.realadvisor.com": {
		name: "Privacy",
		from: "privacy@realadvisor.com",
	},
	"info@ingest.realadvisor.com": { name: "Info", from: "info@realadvisor.com" },
} as const;
export function mailboxConfig(address: string) {
	return mailboxes[address.toLowerCase() as keyof typeof mailboxes];
}
