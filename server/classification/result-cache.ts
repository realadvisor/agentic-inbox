import type { Database } from "../db";
import { JevError } from "./queue";

/** Hash the entire effective request, not merely an email's subject/body.
 * Backfills pin evaluated_at to their start time; different mailbox, recipients,
 * thread context, examples, instructions, model or decision rules cannot collide. */
export async function reuseResult<T>(
	db: Database,
	input: unknown,
	compute: () => Promise<T>,
): Promise<{ value: T; reused: boolean }> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(input)),
	);
	const key = Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	const lease = crypto.randomUUID();
	const [owned] =
		await db`INSERT INTO classifier_result_cache(key,lease,lease_until) VALUES(${key},${lease},now()+interval '90 seconds') ON CONFLICT(key) DO UPDATE SET lease=excluded.lease,lease_until=excluded.lease_until WHERE classifier_result_cache.result IS NULL AND classifier_result_cache.lease_until<now() RETURNING key`;
	if (!owned) {
		const [cached] =
			await db`SELECT result FROM classifier_result_cache WHERE key=${key}`;
		if (cached?.result) return { value: cached.result as T, reused: true };
		throw new JevError("identical_input_pending", true, 5);
	}
	try {
		const value = await compute();
		await db`UPDATE classifier_result_cache SET result=${db.json(value as postgres.JSONValue)},lease_until=now() WHERE key=${key} AND lease=${lease}`;
		return { value, reused: false };
	} catch (error) {
		await db`DELETE FROM classifier_result_cache WHERE key=${key} AND lease=${lease} AND result IS NULL`;
		throw error;
	}
}
import type postgres from "postgres";
