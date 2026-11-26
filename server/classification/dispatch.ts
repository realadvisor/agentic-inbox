import { creditsPaused } from "./provider-state";
import { advanceBackfills } from "./backfills";
import { z } from "zod";
import type { Database } from "../db";
import { processJob, failDelivery, finishRuns } from "./queue";

export const queueNames = {
	live: "inbox-classifications",
	backfill: "inbox-classifier-backfills",
	dead: "inbox-classifications-dead",
} as const;
export const workMessage = z.union([
	z.object({ version: z.literal(1), token: z.string().uuid() }).strict(),
	z
		.object({
			version: z.literal(2),
			tokens: z.array(z.string().uuid()).min(1).max(100),
		})
		.strict(),
]);
function messageTokens(message: z.infer<typeof workMessage>) {
	return message.version === 1 ? [message.token] : message.tokens;
}
export type WorkMessage = z.infer<typeof workMessage>;
export interface QueueBinding {
	sendBatch(
		messages: {
			body: WorkMessage;
			contentType: "json";
			delaySeconds: number;
		}[],
	): Promise<unknown>;
}
export interface QueueMessage {
	body: unknown;
	ack(): void;
	retry(options: { delaySeconds: number }): void;
}
export interface QueueBatch {
	queue: string;
	messages: QueueMessage[];
}
export interface ClassifierQueues {
	live: QueueBinding;
	backfill: QueueBinding;
}

/** Publishing and the published marker cannot be atomic across systems.
 * Commit the marker only after broker acceptance. Ambiguous sends may duplicate;
 * the stable token and consumer lease make those deliveries safe. */
export async function publishOutbox(db: Database, queues: ClassifierQueues) {
	if (await creditsPaused(db)) return 0;
	// Publish and commit new-mail work before touching bulk preparation or delivery.
	const live = await publishPriority(db, queues, true, 100);
	if (live >= 100) return live;
	const advanced = await advanceBackfills(db);
	const bulk = await publishPriority(
		db,
		queues,
		false,
		Math.max(0, 100 - live),
	);
	return advanced ? Math.max(100, live + bulk) : live + bulk;
}

type OutboxRow = {
	job_token: string;
	priority: number;
	mailbox_id: string;
	thread_id: string;
	generation: number;
	delay: number;
};

type ClaimedCandidate = OutboxRow & {
	job_status: string | null;
	active_classifier_id: string | null;
	classifier_enabled: boolean | null;
	classifier_revision: number | null;
	job_revision: number | null;
};

function isPublishable(row: ClaimedCandidate, live: boolean) {
	return (
		row.job_status === "pending" &&
		!!row.active_classifier_id &&
		(row.classifier_enabled === true || row.priority === 2) &&
		row.classifier_revision === row.job_revision &&
		(live ? row.priority === 0 : row.priority !== 0)
	);
}

async function publishPriority(
	db: Database,
	queues: ClassifierQueues,
	live: boolean,
	limit: number,
) {
	if (limit <= 0) return 0;
	const rows = await db.begin(async (tx) => {
		const priorityFilter = live ? tx`o.priority=0` : tx`o.priority<>0`;
		const orderClause = live
			? tx`o.created_at DESC,o.job_token DESC`
			: tx`o.priority,o.created_at,o.job_token`;
		const initial = await tx<ClaimedCandidate[]>`
   WITH batch AS MATERIALIZED (
    SELECT o.job_token,o.created_at
    FROM classifier_outbox o
    WHERE o.published_at IS NULL AND ${priorityFilter}
    ORDER BY ${orderClause}
    LIMIT ${limit}
    FOR UPDATE OF o SKIP LOCKED
   )
   SELECT b.job_token,j.priority,j.mailbox_id,j.thread_id,j.generation,
    greatest(0,ceil(extract(epoch FROM j.available_at-now())))::int AS delay,
    j.status AS job_status,c.id AS active_classifier_id,
    c.enabled AS classifier_enabled,c.revision AS classifier_revision,
    j.revision AS job_revision
   FROM batch b
   LEFT JOIN conversation_classifications j ON j.token=b.job_token
   LEFT JOIN classifiers c ON c.id=j.classifier_id`;
		const orphanTokens: string[] = [];
		const parkTokens: string[] = [];
		const eligible: OutboxRow[] = [];
		const collect = (candidates: ClaimedCandidate[]) => {
			for (const row of candidates) {
				if (isPublishable(row, live)) eligible.push(row);
				else if (row.job_status !== "pending") orphanTokens.push(row.job_token);
				else parkTokens.push(row.job_token);
			}
		};
		collect(initial);
		if (eligible.length < limit) {
			const stale = await tx<ClaimedCandidate[]>`
    WITH batch AS MATERIALIZED (
     SELECT o.job_token,o.created_at
     FROM classifier_outbox o
     WHERE o.published_at<now()-interval '25 hours' AND ${priorityFilter}
     ORDER BY o.published_at,o.created_at,o.job_token
     LIMIT ${limit - eligible.length}
     FOR UPDATE OF o SKIP LOCKED
    )
    SELECT b.job_token,j.priority,j.mailbox_id,j.thread_id,j.generation,
     greatest(0,ceil(extract(epoch FROM j.available_at-now())))::int AS delay,
     j.status AS job_status,c.id AS active_classifier_id,
     c.enabled AS classifier_enabled,c.revision AS classifier_revision,
     j.revision AS job_revision
    FROM batch b
    LEFT JOIN conversation_classifications j ON j.token=b.job_token
    LEFT JOIN classifiers c ON c.id=j.classifier_id`;
			collect(stale);
		}
		if (orphanTokens.length)
			await tx`DELETE FROM classifier_outbox WHERE job_token IN ${tx(orphanTokens)}`;
		if (parkTokens.length)
			await tx`UPDATE classifier_outbox SET published_at=now() WHERE job_token IN ${tx(parkTokens)}`;
		if (!eligible.length) return [];
		// Expand claimed rows to ready siblings in the same conversation so a
		// multi-classifier thread is dispatched as one message instead of racing.
		const threads = new Map<
			string,
			{ mailbox_id: string; thread_id: string; generation: number }
		>();
		for (const row of eligible) {
			threads.set(`${row.mailbox_id}\0${row.thread_id}\0${row.generation}`, {
				mailbox_id: row.mailbox_id,
				thread_id: row.thread_id,
				generation: row.generation,
			});
		}
		const claimedTokens = eligible.map((r) => r.job_token);
		const siblings = await tx<OutboxRow[]>`
   SELECT o.job_token,j.priority,j.mailbox_id,j.thread_id,j.generation,
    greatest(0,ceil(extract(epoch FROM j.available_at-now())))::int AS delay
   FROM jsonb_to_recordset(${tx.json([...threads.values()])}) AS t(mailbox_id text,thread_id uuid,generation int)
   JOIN conversation_classifications j
    ON j.mailbox_id=t.mailbox_id AND j.thread_id=t.thread_id AND j.status='pending' AND j.generation=t.generation
   JOIN classifiers c ON c.id=j.classifier_id
   JOIN classifier_outbox o ON o.job_token=j.token
   WHERE (c.enabled OR j.priority=2) AND c.revision=j.revision
    AND ${live ? tx`j.priority=0` : tx`j.priority<>0`}
    AND (o.published_at IS NULL OR o.published_at<now()-interval '25 hours')
    AND o.job_token NOT IN ${tx(claimedTokens)}
   FOR UPDATE OF o SKIP LOCKED`;
		const all = [...eligible, ...siblings];
		// Hold a short lease outside the transaction while Cloud Tasks accepts the batch.
		await tx`UPDATE classifier_outbox SET published_at=now()-interval '24 hours 55 minutes' WHERE job_token IN ${tx(all.map((r) => r.job_token))}`;
		return all;
	});
	if (!rows.length) return 0;
	const tokens = rows.map((r) => r.job_token);
	const groups = new Map<
		string,
		{ body: WorkMessage; contentType: "json"; delaySeconds: number }[]
	>();
	for (const row of rows) {
		const key = JSON.stringify([
			row.mailbox_id,
			row.thread_id,
			row.generation,
			row.delay,
		]);
		let buckets = groups.get(key);
		if (!buckets) {
			buckets = [];
			groups.set(key, buckets);
		}
		let current = buckets.at(-1);
		if (
			!current ||
			(current.body.version === 2 && current.body.tokens.length >= 100)
		) {
			current = {
				body: { version: 2, tokens: [] },
				contentType: "json",
				delaySeconds: Math.min(86400, row.delay),
			};
			buckets.push(current);
		}
		if (current.body.version === 2) current.body.tokens.push(row.job_token);
	}
	const messages = [...groups.values()].flat();
	try {
		if (messages.length)
			await (live ? queues.live : queues.backfill).sendBatch(messages);
	} catch (error) {
		await db`UPDATE classifier_outbox SET published_at=NULL WHERE job_token IN ${db(tokens)}`.catch(
			() => undefined,
		);
		throw error;
	}
	await db`UPDATE classifier_outbox SET published_at=now() WHERE job_token IN ${db(tokens)}`;
	return rows.length;
}

/** Batch size is one in production; sequential iteration preserves the configured
 * per-queue concurrency cap if the batch size is increased later. */
export async function consumeBatch(
	db: Database,
	key: string,
	batch: QueueBatch,
	request: typeof fetch = fetch,
	maxProcessingAttempts?: number,
) {
	if (
		!Object.values(queueNames).includes(batch.queue as typeof queueNames.live)
	)
		throw new Error("Unexpected classifier queue");
	if (await creditsPaused(db)) {
		await parkBatch(db, batch);
		return;
	}
	for (const message of batch.messages) {
		const parsed = workMessage.safeParse(message.body);
		if (!parsed.success) {
			console.error("Invalid classifier queue envelope discarded");
			message.ack();
			continue;
		}
		try {
			let retry: number | undefined;
			const tokens = messageTokens(parsed.data);
			const exhaustedTokens = new Set<string>();
			if (maxProcessingAttempts !== undefined) {
				const exhausted =
					await db`SELECT token FROM conversation_classifications WHERE token IN ${db(tokens)} AND status='pending' AND attempts-credit_pauses>=${maxProcessingAttempts}`;
				for (const job of exhausted) exhaustedTokens.add(job.token);
			}
			// Retire exhausted siblings before processJob atomically claims the
			// remaining questions in the conversation.
			tokens.sort(
				(a, b) =>
					Number(exhaustedTokens.has(b)) - Number(exhaustedTokens.has(a)),
			);
			for (const token of tokens) {
				const exhausted = exhaustedTokens.has(token);
				const result =
					batch.queue === queueNames.dead || exhausted
						? await failDelivery(db, token)
						: await processJob(db, key, token, request);
				if ("retry" in result)
					retry = Math.min(retry ?? Infinity, result.retry);
			}
			if (retry !== undefined) message.retry({ delaySeconds: retry });
			else message.ack();
		} catch {
			// Never log email content, keys, or provider response bodies.
			console.error("Classifier delivery failed; requesting broker retry");
			message.retry({
				delaySeconds: batch.queue === queueNames.dead ? 900 : 60,
			});
		}
	}
}

/** Paused deliveries remain in the outbox and are republished after re-enabling. */
export async function parkBatch(db: Database, batch: QueueBatch) {
	for (const message of batch.messages) {
		const parsed = workMessage.safeParse(message.body);
		if (parsed.success)
			await db`UPDATE classifier_outbox SET published_at=NULL WHERE job_token IN ${db(messageTokens(parsed.data))}`;
		message.ack();
	}
}
