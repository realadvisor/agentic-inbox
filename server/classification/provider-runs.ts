import { providerError } from "../../shared/jev-budget";
import type { DecisionRules } from "../../shared/decision-rules";
import { z } from "zod";
import type { Database } from "../db";
import { interpretAnswer, type JevQuestion } from "../../shared/jev-request";

export interface CaptureJob {
	decision_rules?: Partial<DecisionRules>;
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
		await tx`INSERT INTO classifier_provider_run_items ${tx(
			jobs.map((j, index) => ({
				run_id: runId,
				decision_rules: tx.json(j.decision_rules ?? {}),
				question_key: j.question_key ?? keys[index],
				classifier_id: j.classifier_id,
				classifier_name: j.classifier_name,
				question: j.question,
				revision: j.revision,
				generation: j.generation,
				job_token: j.token,
				lease_id: j.lease_id,
				attempt: j.attempts,
			})),
		)}`;
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
	const providerDurationMs = Date.now() - start;
	let parsed: z.infer<typeof responseSchema> | undefined;
	try {
		parsed = responseSchema.parse(JSON.parse(raw));
	} catch {
		/* Retain malformed JSON verbatim for inspection. */
	}
	let error = !response.ok
		? providerError(
				response.status,
				(() => {
					try {
						return JSON.parse(raw);
					} catch {
						return null;
					}
				})(),
			)
		: !parsed
			? "invalid_provider_response"
			: null;
	const answers: {
		token: string;
		probability: number;
		answer: boolean | null;
	}[] = [];
	for (const [index, j] of jobs.entries()) {
		const key = j.question_key ?? keys[index];
		if (response.ok && parsed) {
			try {
				const answer = interpretAnswer(
					payload.questions[key],
					parsed.answers[key],
					j.option,
					j.decision_rules,
				);
				answers.push({
					token: j.token,
					probability: answer.probability,
					answer: answer.answer,
				});
			} catch {
				error = "invalid_provider_answer";
			}
		}
	}

	await db.begin(async (tx) => {
		if (answers.length)
			await tx`UPDATE classifier_provider_run_items i SET probability=a.probability,answer=a.answer FROM jsonb_to_recordset(${tx.json(answers)}) AS a(token uuid,probability double precision,answer boolean) WHERE i.run_id=${runId} AND i.job_token=a.token`;
		if (error)
			await tx`UPDATE classifier_provider_run_items SET disposition='failed',error=${error} WHERE run_id=${runId}`;
		await tx`UPDATE classifier_provider_runs SET status=${error ? "failed" : "succeeded"},finished_at=clock_timestamp(),duration_ms=${providerDurationMs},http_status=${response.status},returned_model=${parsed?.model ?? null},response_body=${raw},error=${error} WHERE id=${runId}`;
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
