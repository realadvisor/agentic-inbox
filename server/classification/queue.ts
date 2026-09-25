import {
	requestFits,
	providerError,
	withoutExamples,
} from "../../shared/jev-budget";
import type { DecisionRules } from "../../shared/decision-rules";
import { curatedQuestion } from "./curated-examples";
import {
	interpretAnswer,
	type JevQuestion,
	jevQuestion,
	jevRequest,
} from "../../shared/jev-request";
import { captureProviderRequest, type CaptureJob } from "./provider-runs";
import { batchRequests } from "./batch";
import { type HumanExample } from "./examples";
import { conversationState, ConversationSizeError } from "./state";
import type { TagGroupInput } from "../../shared/tag-groups";
import type { Database } from "../db";

interface Job {
	priority: number;
	mailbox_id: string;
	thread_id: string;
	classifier_id: string;
	revision: number;
	generation: number;
	attempts: number;
	token: string;
	lease_until: Date | null;
	available_at: Date;
	run_id: string | null;
}

export class JevError extends Error {
	constructor(
		public code: string,
		public retryable: boolean,
		public delay = 0,
	) {
		super(code);
	}
}
export async function askJev(
	key: string,
	question: string,
	state: unknown,
	request: typeof fetch = fetch,
	examples: HumanExample[] = [],
	typedQuestion?: JevQuestion,
	option?: string,
	rules?: Partial<DecisionRules>,
) {
	const prepared = jevRequest(state, {
		match: typedQuestion ?? jevQuestion(question, examples),
	});
	if (!requestFits(state, prepared.questions))
		prepared.questions.match = withoutExamples(
			prepared.questions.match,
		) as JevQuestion;
	if (!requestFits(state, prepared.questions))
		throw new JevError("provider_context_limit", false);
	let response: Response;
	try {
		response = await request("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(prepared),
			signal: AbortSignal.timeout(20_000),
		});
	} catch {
		throw new JevError("provider_unavailable", true);
	}
	if (!response.ok) {
		const retry = response.headers.get("retry-after");
		const seconds = retry
			? Number.isFinite(Number(retry))
				? Number(retry)
				: (Date.parse(retry) - Date.now()) / 1000
			: 0;
		throw new JevError(
			providerError(response.status, await response.json().catch(() => null)),
			response.status === 429 ||
				response.status >= 500 ||
				response.status === 408,
			Math.min(3600, Math.max(0, seconds || 0)),
		);
	}
	let value;
	try {
		value = (await response.json()) as {
			model?: string;
			answers?: { match?: { type?: string; noul?: number } };
		};
	} catch {
		throw new JevError("invalid_provider_response", true);
	}
	try {
		return {
			...interpretAnswer(
				typedQuestion ?? jevQuestion(question, examples),
				value?.answers?.match,
				option,
				rules,
			),
			model: value?.model ?? "jev-latest",
		};
	} catch {
		throw new JevError("invalid_provider_answer", true);
	}
}

export async function finishRuns(db: Database) {
	await db`UPDATE classifier_runs r SET status='completed' WHERE status='running' AND NOT EXISTS(SELECT 1 FROM classifier_run_items i WHERE i.run_id=r.id AND i.status='pending')`;
}

export type DeliveryResult = { ack: true } | { retry: number };

/** A broker delivery also handles ready sibling questions for this conversation.
 * Each sibling still owns its original token and broker delivery for retries. */
export async function processJob(
	db: Database,
	key: string,
	token: string,
	request: typeof fetch = fetch,
): Promise<DeliveryResult> {
	const claims = await claimJobs(db, token);
	const contexts = new Map<number, CaptureJob>();
	const evaluatedAt = new Date();
	const states = new Map<string, ReturnType<typeof conversationState>>();
	const loadState = (job: Job) => {
		const id = `${job.mailbox_id}/${job.thread_id}/${job.generation}`;
		let state = states.get(id);
		if (!state) {
			state = conversationState(db, job.mailbox_id, job.thread_id, evaluatedAt);
			states.set(id, state);
		}
		return state;
	};
	const batch = batchRequests(
		request,
		claims.length,
		(url, init, indexes, questionKeys) =>
			captureProviderRequest(
				db,
				request,
				url,
				init,
				indexes.map((index) => {
					const job = contexts.get(index);
					if (!job) throw new Error("Missing classifier log context");
					return {
						...job,
						question_key: questionKeys?.[indexes.indexOf(index)],
					};
				}),
			),
	);
	const results = await Promise.allSettled(
		claims.map((claimed, index) =>
			processSingleJob(
				db,
				key,
				claimed,
				batch.forJob(index),
				(job) => contexts.set(index, job),
				loadState,
			).finally(() => batch.done(index)),
		),
	);
	for (const result of results)
		if (result.status === "rejected") throw result.reason;
	for (const result of results) {
		if (result.status === "fulfilled" && "retry" in result.value)
			return result.value;
	}
	return { ack: true };
}

async function claimJobs(db: Database, token: string) {
	return db.begin(async (tx) => {
		const [anchor] = await tx<
			Job[]
		>`SELECT * FROM conversation_classifications WHERE token=${token} AND status='pending'`;
		if (!anchor) return [];
		// Use the same lock order as configuration writers. Commit every ready
		// sibling's lease together so competing deliveries cannot split a batch.
		const classifiers =
			await tx`SELECT c.* FROM classifiers c JOIN conversation_classifications j ON j.classifier_id=c.id WHERE j.mailbox_id=${anchor.mailbox_id} AND j.thread_id=${anchor.thread_id} AND j.generation=${anchor.generation} AND j.status='pending' ORDER BY c.id FOR UPDATE OF c`;
		const [conversation] =
			await tx`SELECT generation FROM conversations WHERE mailbox_id=${anchor.mailbox_id} AND thread_id=${anchor.thread_id} FOR UPDATE`;
		const jobs = await tx<
			(Job & { seconds: number })[]
		>`SELECT j.*, greatest(0,ceil(extract(epoch FROM greatest(j.lease_until,j.available_at,p.cooldown_until)-now())))::int AS seconds FROM conversation_classifications j CROSS JOIN classifier_provider_state p WHERE j.mailbox_id=${anchor.mailbox_id} AND j.thread_id=${anchor.thread_id} AND j.generation=${anchor.generation} AND j.status='pending' AND (j.token=${token} OR j.available_at<=now()) AND p.singleton ORDER BY j.classifier_id FOR UPDATE OF j`;
		const claims = jobs.map((job) => {
			const classifier = classifiers.find((c) => c.id === job.classifier_id);
			if (
				!classifier ||
				(!classifier.enabled && job.priority !== 2) ||
				classifier.revision !== job.revision ||
				conversation?.generation !== job.generation
			)
				return { ack: true } as const;
			if (job.seconds > 0) return { retry: Math.min(86400, job.seconds + 1) };
			return {
				...job,
				attempts: job.attempts + 1,
				lease_id: crypto.randomUUID(),
				question: classifier.question,
				decision_rules: classifier.decision_rules as Partial<DecisionRules>,
				tag_id: classifier.tag_id,
				include_reviewed_examples: classifier.include_reviewed_examples,
			};
		});
		const leases = claims.flatMap((c) =>
			"token" in c ? [{ token: c.token, lease_id: c.lease_id }] : [],
		);
		if (leases.length)
			await tx`UPDATE conversation_classifications j SET lease_id=l.lease_id,lease_until=now()+interval '90 seconds',attempts=attempts+1 FROM jsonb_to_recordset(${tx.json(leases)}) AS l(token uuid,lease_id uuid) WHERE j.token=l.token`;
		return claims;
	});
}

/** Process exactly the version named by the broker. Leases only deduplicate delivery;
 * concurrency, scheduling and redelivery belong to Cloudflare Queues. */
async function processSingleJob(
	db: Database,
	key: string,
	claimed: Awaited<ReturnType<typeof claimJobs>>[number],
	request: typeof fetch,
	onClaim: (job: CaptureJob) => void,
	loadState: (job: Job) => ReturnType<typeof conversationState>,
): Promise<DeliveryResult> {
	if (claimed.ack === true) return { ack: true };
	if (claimed.retry !== undefined) return { retry: claimed.retry };
	const j = claimed;
	const [tag] = await db`SELECT name FROM tags WHERE id=${j.tag_id}`;
	onClaim({ ...j, classifier_name: tag.name, option: j.tag_id });
	let delivery: DeliveryResult = { ack: true };

	let result: {
		answer: boolean | null;
		probability: number | null;
		model: string | null;
		status: string;
		error: string | null;
	} = {
		answer: null,
		probability: null,
		model: null,
		status: "review",
		error: null,
	};
	let failure: JevError | undefined;
	try {
		const [eligibility] =
			await db`SELECT (classifier_thread_active(${j.mailbox_id},${j.thread_id}) OR (${j.priority === 2} AND EXISTS(SELECT 1 FROM emails WHERE mailbox_id=${j.mailbox_id} AND thread_id=${j.thread_id} AND delivery_status IN ('received','sent') AND folder_id NOT IN ('trash','spam')))) AS active, tag_manually_overridden(${j.mailbox_id},${j.thread_id},${j.tag_id}) AS manual`;
		if (!eligibility.active || eligibility.manual) result.status = "skipped";
		else {
			const state = await loadState(j);
			const [group] =
				await db`SELECT g.*, (SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color,'description',t.description) ORDER BY t.position,t.id) FROM tags t WHERE t.group_id=g.id AND t.archived_at IS NULL) AS tags FROM tag_groups g JOIN tags t ON t.group_id=g.id WHERE t.id=${j.tag_id}`;
			const typedQuestion = await curatedQuestion(db, {
				target: group
					? { group_id: group.id }
					: { classifier_id: j.classifier_id },
				mailbox: j.mailbox_id,
				thread: j.thread_id,
				state,
				group: group as TagGroupInput | undefined,
				question: j.question,
				option: j.tag_id,
				legacy: j.include_reviewed_examples,
			});

			const answer = await askJev(
				key,
				j.question,
				state,
				request,
				[],
				typedQuestion,
				j.tag_id,
				j.decision_rules,
			);
			result = {
				...answer,
				status: answer.answer === null ? "review" : "complete",
				error: null,
			};
		}
	} catch (error) {
		failure =
			error instanceof ConversationSizeError
				? new JevError("conversation_too_large", false)
				: error instanceof JevError
					? error
					: new JevError("processing_failed", true);
	}
	try {
		await db.begin(async (tx) => {
			const [classifier] =
				await tx`SELECT * FROM classifiers WHERE id=${j.classifier_id} FOR UPDATE`;
			const [conversation] =
				await tx`SELECT generation FROM conversations WHERE mailbox_id=${j.mailbox_id} AND thread_id=${j.thread_id} FOR UPDATE`;
			const [current] =
				await tx`SELECT * FROM conversation_classifications WHERE mailbox_id=${j.mailbox_id} AND thread_id=${j.thread_id} AND classifier_id=${j.classifier_id} FOR UPDATE`;
			if (
				!current ||
				current.token !== j.token ||
				current.lease_id !== j.lease_id ||
				current.status !== "pending" ||
				!classifier ||
				(!classifier.enabled && j.priority !== 2) ||
				classifier.revision !== j.revision ||
				conversation?.generation !== j.generation
			) {
				await tx`UPDATE classifier_provider_run_items SET disposition='discarded' WHERE lease_id=${j.lease_id}`;
				return;
			}
			if (failure?.retryable) {
				const delay = Math.max(
					failure.delay,
					Math.min(3600, 30 * 2 ** Math.min(j.attempts - 1, 7)) +
						Math.floor(Math.random() * 15),
				);
				await tx`UPDATE conversation_classifications SET lease_until=NULL,available_at=now()+${delay}*interval '1 second',error=${failure.code},updated_at=now() WHERE token=${j.token}`;
				if (failure.code === "provider_http_429")
					await tx`UPDATE classifier_provider_state SET cooldown_until=greatest(cooldown_until,now()+${delay}*interval '1 second') WHERE singleton`;
				await tx`UPDATE classifier_provider_run_items SET disposition='retry',error=${failure.code} WHERE lease_id=${j.lease_id}`;
				delivery = { retry: Math.ceil(delay) };
				return;
			}
			if (failure)
				result = {
					...result,
					status: ["provider_context_limit", "conversation_too_large"].includes(
						failure.code,
					)
						? "review"
						: "error",
					error: failure.code,
				};
			const [manual] =
				await tx`SELECT 1 WHERE tag_manually_overridden(${j.mailbox_id},${j.thread_id},${classifier.tag_id})`;
			if (manual) result.status = "skipped";
			await tx`UPDATE classifier_provider_run_items SET disposition=${result.status === "skipped" ? "discarded" : result.status === "error" ? "failed" : result.status === "review" ? "review" : "applied"},probability=${result.probability},answer=${result.answer},error=${result.error} WHERE lease_id=${j.lease_id} AND disposition<>'failed'`;
			await tx`UPDATE conversation_classifications SET status=${result.status},answer=${result.answer},probability=${result.probability},model=${result.model},error=${result.error},lease_until=NULL,updated_at=now() WHERE token=${j.token}`;
			if (result.status !== "skipped")
				await tx`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at) VALUES(${j.mailbox_id},${j.thread_id},${classifier.tag_id},'classifier','jev',${result.answer === true ? null : tx`now()`}) ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET actor='jev',removed_at=excluded.removed_at,updated_at=now() WHERE conversation_tags.source='classifier'`;
			if (j.run_id)
				await tx`UPDATE classifier_run_items SET status=${result.status === "error" ? "failed" : result.status} WHERE run_id=${j.run_id} AND mailbox_id=${j.mailbox_id} AND thread_id=${j.thread_id} AND status='pending'`;
		});
	} finally {
		await db`UPDATE conversation_classifications SET lease_id=NULL,lease_until=NULL WHERE token=${j.token} AND lease_id=${j.lease_id}`;
	}
	await finishRuns(db);
	return delivery;
}

/** Called only by the dead-letter consumer after broker retries are exhausted. */
export async function failDelivery(
	db: Database,
	token: string,
): Promise<DeliveryResult> {
	const result = await db.begin(async (tx) => {
		const [candidate] = await tx<
			Job[]
		>`SELECT * FROM conversation_classifications WHERE token=${token} AND status='pending'`;
		if (!candidate) return { ack: true } as const;
		await tx`SELECT id FROM classifiers WHERE id=${candidate.classifier_id} FOR UPDATE`;
		await tx`SELECT generation FROM conversations WHERE mailbox_id=${candidate.mailbox_id} AND thread_id=${candidate.thread_id} FOR UPDATE`;
		const [current] =
			await tx`SELECT greatest(0,ceil(extract(epoch FROM lease_until-now())))::int AS remaining FROM conversation_classifications WHERE token=${token} AND status='pending' FOR UPDATE`;
		if (current?.remaining > 0) return { retry: current.remaining + 1 };
		const [row] =
			await tx`UPDATE conversation_classifications SET status='error',error=coalesce(error,'queue_delivery_exhausted'),lease_until=NULL,lease_id=NULL,updated_at=now() WHERE token=${token} AND status='pending' RETURNING *`;
		if (row?.run_id)
			await tx`UPDATE classifier_run_items SET status='failed' WHERE run_id=${row.run_id} AND mailbox_id=${row.mailbox_id} AND thread_id=${row.thread_id} AND status='pending'`;
		return { ack: true } as const;
	});
	await finishRuns(db);
	return result.ack === true ? { ack: true } : { retry: result.retry };
}
