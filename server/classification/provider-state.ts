import type { Database } from "../db";

export class JevCreditPaused extends Error {}
export async function providerState(db: Database) {
	const [state] = await db`SELECT paused_at,paused_at IS NOT NULL AS paused,
 (paused_at IS NOT NULL AND resume_until>now()) IS TRUE AS checking,resume_error
 FROM classifier_provider_state WHERE singleton`;
	return state;
}
export async function creditsPaused(db: Database) {
	const [state] =
		await db`SELECT paused_at IS NOT NULL AS paused FROM classifier_provider_state WHERE singleton`;
	return state.paused as boolean;
}
/** Check immediately before each actual HTTP call, including batch splits and tests.
 * Already in-flight requests may finish; no email content is stored in this state. */
export function creditGuard(
	db: Database,
	transport: typeof fetch,
): typeof fetch {
	return async (url, init) => {
		if (await creditsPaused(db)) throw new JevCreditPaused();
		const response = await transport(url, init);
		if (response.status === 402)
			await db`UPDATE classifier_provider_state SET paused_at=coalesce(paused_at,now()),pause_version=pause_version+1,resume_error='provider_http_402' WHERE singleton`;
		return response;
	};
}
export async function parkTokens(db: Database, tokens: string[]) {
	if (tokens.length)
		await db`UPDATE classifier_outbox SET published_at=NULL WHERE job_token IN ${db(tokens)}`;
}
