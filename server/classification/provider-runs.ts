import { z } from "zod";
import type { Database } from "../db";
import { interpretAnswer, type JevQuestion } from "../../shared/jev-request";

export interface CaptureJob {
	option?: string;
	question_key?: string;
	mailbox_id: string;
	thread_id: string;
	classifier_id: string;
	classifier_name: string;
	question: string;
	revision: number;
	generation: number;
	token: string;
	lease_id: string;
	attempts: number;
}
const responseSchema = z.object({
	model: z.string().optional(),
	answers: z.record(z.unknown()),
});

/** Runs are private inbox data, never console logs. Headers are deliberately excluded. */
export async function captureProviderRequest(
	db: Database,
	request: typeof fetch,
	url: Parameters<typeof fetch>[0],
	init: RequestInit,
	jobs: CaptureJob[],
) {
	const body = String(init.body);
	const payload = JSON.parse(body) as {
		model: string;
		state: { messages?: { subject?: string }[] };
		questions: Record<string, JevQuestion>;
	};
	const keys = Object.keys(payload.questions);
	if (
		!jobs.length ||
		jobs.some((j, i) => !payload.questions[j.question_key ?? keys[i]])
	)
		throw new Error("Invalid classifier log mapping");
	const runId = crypto.randomUUID();
	await db.begin(async (tx) => {
		await tx`INSERT INTO classifier_provider_runs(id,mailbox_id,thread_id,subject,requested_model,request_body) VALUES(${runId},${jobs[0].mailbox_id},${jobs[0].thread_id},${payload.state.messages?.at(-1)?.subject ?? "Conversation"},${payload.model},${body})`;
		for (const [index, j] of jobs.entries())
			await tx`INSERT INTO classifier_provider_run_items(run_id,question_key,classifier_id,classifier_name,question,revision,generation,job_token,lease_id,attempt) VALUES(${runId},${j.question_key ?? keys[index]},${j.classifier_id},${j.classifier_name},${j.question},${j.revision},${j.generation},${j.token},${j.lease_id},${j.attempts})`;
	});
	const start = Date.now();
	let response: Response;
	let raw: string;
	try {
		response = await request(url, init);
		raw = await response.text();
	} catch (error) {
		const code =
			init.signal?.aborted ||
			(error instanceof Error && error.name === "TimeoutError")
				? "provider_timeout"
				: "provider_unavailable";
		await db`UPDATE classifier_provider_runs SET status='failed',finished_at=now(),duration_ms=${Date.now() - start},error=${code} WHERE id=${runId}`;
		throw error;
	}
	let parsed: z.infer<typeof responseSchema> | undefined;
	try {
		parsed = responseSchema.parse(JSON.parse(raw));
	} catch {
		/* Retain malformed JSON verbatim for inspection. */
	}
	let error = !response.ok
		? `provider_http_${response.status}`
		: !parsed
			? "invalid_provider_response"
			: null;
	await db.begin(async (tx) => {
		for (const [index, j] of jobs.entries()) {
			const key = j.question_key ?? keys[index];
			if (response.ok && parsed) {
				try {
					const answer = interpretAnswer(
						payload.questions[key],
						parsed.answers[key],
						j.option,
					);
					await tx`UPDATE classifier_provider_run_items SET probability=${answer.probability},answer=${answer.answer} WHERE run_id=${runId} AND job_token=${j.token}`;
				} catch {
					error = "invalid_provider_answer";
				}
			}
		}

		await tx`UPDATE classifier_provider_runs SET status=${error ? "failed" : "succeeded"},finished_at=now(),duration_ms=${Date.now() - start},http_status=${response.status},returned_model=${parsed?.model ?? null},response_body=${raw},error=${error} WHERE id=${runId}`;
	});
	// Rebuild the consumed response so existing parsing/retry behavior stays intact.
	return new Response(
		response.status === 204 ||
			response.status === 205 ||
			response.status === 304
			? null
			: raw,
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
}

export async function pruneProviderRuns(db: Database, days = 30) {
	if (!Number.isInteger(days) || days < 1 || days > 365)
		throw new Error("Invalid classifier log retention");
	await db`DELETE FROM classifier_provider_runs WHERE started_at < now()-${days}*interval '1 day'`;
	await db`UPDATE classifier_provider_run_items i SET disposition='failed',error='application_interrupted' FROM classifier_provider_runs r WHERE i.run_id=r.id AND i.disposition='pending' AND r.started_at < now()-interval '5 minutes'`;
	await db`UPDATE classifier_provider_runs SET status='interrupted',error='worker_interrupted' WHERE status='running' AND started_at < now()-interval '5 minutes'`;
}
