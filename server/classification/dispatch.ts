import { z } from "zod";
import type { Database } from "../db";
import { processJob, failDelivery, finishRuns } from "./queue";

export const queueNames = {
	live: "inbox-classifications",
	backfill: "inbox-classifier-backfills",
	dead: "inbox-classifications-dead",
} as const;
export const workMessage = z
	.object({ version: z.literal(1), token: z.string().uuid() })
	.strict();
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
	return db.begin(async (tx) => {
		const rows =
			await tx`SELECT o.job_token,j.priority,greatest(0,ceil(extract(epoch FROM j.available_at-now())))::int AS delay
   FROM classifier_outbox o JOIN conversation_classifications j ON j.token=o.job_token JOIN classifiers c ON c.id=j.classifier_id
   WHERE (o.published_at IS NULL OR o.published_at<now()-interval '25 hours') AND j.status='pending' AND (c.enabled OR j.priority=2) AND c.revision=j.revision
   ORDER BY j.priority,o.created_at,o.job_token LIMIT 100 FOR UPDATE OF o SKIP LOCKED`;
		for (const priority of [0, 1]) {
			const messages = rows
				.filter((r) => (r.priority === 0 ? 0 : 1) === priority)
				.map((r) => ({
					body: { version: 1 as const, token: r.job_token as string },
					contentType: "json" as const,
					delaySeconds: Math.min(86400, r.delay),
				}));
			if (messages.length)
				await (priority === 0 ? queues.live : queues.backfill).sendBatch(
					messages,
				);
		}
		if (rows.length)
			await tx`UPDATE classifier_outbox SET published_at=now() WHERE job_token IN ${tx(rows.map((r) => r.job_token))}`;
		return rows.length;
	});
}

/** Batch size is one in production; sequential iteration preserves the configured
 * per-queue concurrency cap if the batch size is increased later. */
export async function consumeBatch(
	db: Database,
	key: string,
	batch: QueueBatch,
	request: typeof fetch = fetch,
) {
	if (
		!Object.values(queueNames).includes(batch.queue as typeof queueNames.live)
	)
		throw new Error("Unexpected classifier queue");
	for (const message of batch.messages) {
		const parsed = workMessage.safeParse(message.body);
		if (!parsed.success) {
			console.error("Invalid classifier queue envelope discarded");
			message.ack();
			continue;
		}
		try {
			if (batch.queue === queueNames.dead) {
				const result = await failDelivery(db, parsed.data.token);
				if ("retry" in result) message.retry({ delaySeconds: result.retry });
				else message.ack();
				continue;
			}
			const result = await processJob(db, key, parsed.data.token, request);
			if ("retry" in result) message.retry({ delaySeconds: result.retry });
			else message.ack();
		} catch {
			// Never log email content, keys, or provider response bodies.
			console.error("Classifier delivery failed; requesting broker retry");
			message.retry({
				delaySeconds: batch.queue === queueNames.dead ? 900 : 60,
			});
		}
	}
	await finishRuns(db);
}

/** Paused deliveries remain in the outbox and are republished after re-enabling. */
export async function parkBatch(db: Database, batch: QueueBatch) {
	for (const message of batch.messages) {
		const parsed = workMessage.safeParse(message.body);
		if (parsed.success)
			await db`UPDATE classifier_outbox SET published_at=NULL WHERE job_token=${parsed.data.token}`;
		message.ack();
	}
}
