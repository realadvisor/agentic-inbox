import type { Database } from "../db";
import type { QueueBinding } from "../classification/dispatch";
import { decryptSecret, signature, validateDestination } from "./security";
export async function publishWebhooks(db: Database, queue: QueueBinding) {
	return db.begin(async (tx) => {
		const rows =
			await tx`SELECT id,greatest(0,ceil(extract(epoch FROM available_at-now())))::int delay FROM webhook_deliveries WHERE status='pending' AND (published_at IS NULL OR published_at<now()-interval '1 hour') ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`;
		if (!rows.length) return;
		await queue.sendBatch(
			rows.map((r) => ({
				body: { version: 1, token: r.id },
				contentType: "json",
				delaySeconds: r.delay,
			})),
		);
		await tx`UPDATE webhook_deliveries SET published_at=now() WHERE id IN ${tx(rows.map((r) => r.id))}`;
	});
}
export async function deliverWebhook(
	db: Database,
	id: string,
	master: string,
	request: typeof fetch = fetch,
	resolve = validateDestination,
): Promise<number | undefined> {
	const row = await db.begin(async (tx) => {
		const [d] =
			await tx`SELECT d.*,e.url,e.secret,e.enabled,v.payload FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id JOIN webhook_events v ON v.id=d.event_id WHERE d.id=${id} FOR UPDATE OF d`;
		if (!d || d.status !== "pending") return;
		if (!d.enabled) {
			await tx`UPDATE webhook_deliveries SET status='skipped' WHERE id=${id}`;
			return;
		}
		if (d.lease_until > new Date() || d.available_at > new Date())
			return { retry: 30 };
		const lease = crypto.randomUUID();
		await tx`UPDATE webhook_deliveries SET lease_id=${lease},lease_until=now()+interval '60 seconds',attempts=attempts+1 WHERE id=${id}`;
		return {
			url: d.url as string,
			secret: d.secret as string,
			payload: d.payload as { id: string },
			lease,
			attempts: Number(d.attempts) + 1,
		};
	});
	if (!row) return;
	if ("retry" in row) return row.retry;
	const started = Date.now();
	let status: number | null = null,
		responseText = "",
		error: string | null = null;
	try {
		await resolve(row.url);
		const secret = await decryptSecret(row.secret, master);
		const body = JSON.stringify(row.payload);
		const timestamp = String(Math.floor(Date.now() / 1000));
		const response = await request(row.url, {
			method: "POST",
			redirect: "error",
			headers: {
				"Content-Type": "application/json",
				"X-Webhook-ID": row.payload.id,
				"X-Webhook-Timestamp": timestamp,
				"X-Webhook-Signature": await signature(secret, timestamp, body),
			},
			body,
			signal: AbortSignal.timeout(10000),
		});
		status = response.status;
		// Bound response reads, including endpoints that never finish streaming.
		const reader = response.body?.getReader();
		if (reader) {
			let size = 0;
			try {
				while (size < 4096) {
					const part = await reader.read();
					if (part.done) break;
					const bytes = part.value.slice(0, 4096 - size);
					size += bytes.length;
					responseText += new TextDecoder().decode(bytes);
				}
			} finally {
				await reader.cancel();
			}
		}
		if (status < 200 || status >= 300) error = `HTTP ${status}`;
	} catch {
		error = "Delivery failed (network, timeout, or invalid destination)";
	}
	const retry =
		!!error &&
		row.attempts < 5 &&
		(status === null || status === 408 || status === 429 || status >= 500);
	const delay = Math.min(3600, 30 * 2 ** (row.attempts - 1));
	await db.begin(async (tx) => {
		const changed =
			await tx`UPDATE webhook_deliveries SET status=${!error ? "success" : retry ? "pending" : "failed"},lease_until=NULL,lease_id=NULL,available_at=now()+${delay}*interval '1 second' WHERE id=${id} AND lease_id=${row.lease} RETURNING id`;
		if (!changed.length) return;
		await tx`INSERT INTO webhook_attempts(delivery_id,attempt,status_code,error,response,duration_ms) VALUES(${id},${row.attempts},${status},${error},${responseText},${Date.now() - started})`;
	});
	return retry ? delay : undefined;
}
