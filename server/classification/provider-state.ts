import type { Database } from "../db";

export class JevCreditPaused extends Error {}
export async function providerState(db: Database) {
	const [state] = await db`SELECT paused_at,paused_at IS NOT NULL AS paused,
 (paused_at IS NOT NULL AND resume_until>now()) IS TRUE AS checking,resume_error
 FROM classifier_provider_state WHERE singleton`;
	return state;
}
/** Health for monitoring with any API key: a pause flag, queue lag, and times,
 * never mail content, addresses or subjects. last_classified_at is when the
 * newest successful Jev request finished. */
export async function classifierHealth(db: Database) {
	const [state] =
		await db`SELECT paused_at IS NOT NULL AS paused,paused_at,resume_error,
 (SELECT r.finished_at FROM classifier_provider_runs r WHERE r.status='succeeded' ORDER BY r.started_at DESC,r.id DESC LIMIT 1) AS last_classified_at,
 (SELECT count(*)::int FROM classifier_outbox WHERE priority=0) AS pending_live_jobs,
 (SELECT min(created_at) FROM classifier_outbox WHERE priority=0) AS oldest_pending_live_at,
 (SELECT count(*)::int FROM classifier_provider_runs WHERE started_at>now()-interval '15 minutes' AND status IN ('failed','interrupted')) AS recent_failed_runs
 FROM classifier_provider_state WHERE singleton`;
	return {
		paused: state.paused as boolean,
		paused_at: state.paused_at as Date | null,
		resume_error: state.resume_error as string | null,
		last_classified_at: state.last_classified_at as Date | null,
		pending_live_jobs: Number(state.pending_live_jobs ?? 0),
		oldest_pending_live_at: state.oldest_pending_live_at as Date | null,
		recent_failed_runs: Number(state.recent_failed_runs ?? 0),
	};
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
