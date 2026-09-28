import { isIP } from "node:net";
const enc = new TextEncoder();
export function validateUrl(value: string) {
	const url = new URL(value);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.hash ||
		(url.port && url.port !== "443") ||
		isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
		!url.hostname.includes(".") ||
		/\.(localhost|local|internal|test|invalid)$/i.test(url.hostname)
	)
		throw new Error(
			"Use a public HTTPS hostname without credentials or a custom port",
		);
	return url;
}
function publicAddress(ip: string) {
	if (isIP(ip) === 4) {
		const [a, b] = ip.split(".").map(Number);
		return !(
			a === 0 ||
			a === 10 ||
			a === 127 ||
			a >= 224 ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 198 && (b === 18 || b === 19))
		);
	}
	// Public IPv6 global unicast only; exclude documentation and mapped addresses.
	return (
		isIP(ip) === 6 &&
		/^[23]/i.test(ip) &&
		!ip.toLowerCase().startsWith("2001:db8:")
	);
}
export async function validateDestination(
	value: string,
	request: typeof fetch = fetch,
) {
	const url = validateUrl(value);
	const results = await Promise.all(
		["A", "AAAA"].map(async (type) => {
			const response = await request(
				`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(url.hostname)}&type=${type}`,
				{
					headers: { Accept: "application/dns-json" },
					signal: AbortSignal.timeout(5000),
				},
			);
			if (!response.ok) throw new Error("DNS validation failed");
			const data = (await response.json()) as {
				Status: number;
				Answer?: { type: number; data: string }[];
			};
			if (data.Status !== 0) throw new Error("DNS validation failed");
			return (data.Answer ?? [])
				.filter((a) => a.type === 1 || a.type === 28)
				.map((a) => a.data);
		}),
	);
	const addresses = results.flat();
	if (!addresses.length || addresses.some((ip) => !publicAddress(ip)))
		throw new Error("Destination must resolve to public addresses");
	return url;
}
async function key(value: string) {
	if (!/^[a-f0-9]{64}$/i.test(value))
		throw new Error("Webhook encryption is not configured");
	return crypto.subtle.importKey(
		"raw",
		Uint8Array.from(value.match(/../g)!.map((v) => parseInt(v, 16))),
		"AES-GCM",
		false,
		["encrypt", "decrypt"],
	);
}
export async function encryptSecret(secret: string, master: string) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encrypted = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		await key(master),
		enc.encode(secret),
	);
	return (
		Buffer.from(iv).toString("base64") +
		"." +
		Buffer.from(encrypted).toString("base64")
	);
}
export async function decryptSecret(value: string, master: string) {
	const [iv, data] = value.split(".");
	return new TextDecoder().decode(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: Buffer.from(iv, "base64") },
			await key(master),
			Buffer.from(data, "base64"),
		),
	);
}
export async function signature(
	secret: string,
	timestamp: string,
	body: string,
) {
	const k = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return (
		"v1=" +
		Buffer.from(
			await crypto.subtle.sign("HMAC", k, enc.encode(timestamp + "." + body)),
		).toString("hex")
	);
}
