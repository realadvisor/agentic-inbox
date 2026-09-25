import { HTTPException } from "hono/http-exception";
import type { Database } from "../db";
import {
	claimRun,
	executeRun,
	getSettings,
	type ModelFactory,
} from "./service";
import type { QueueBinding, QueueBatch } from "../classification/dispatch";
import { workMessage } from "../classification/dispatch";

export const AGENT_QUEUE = "inbox-agent-drafts";
export async function publishAgentJobs(db: Database, queue: QueueBinding) {
	await db.begin(async (tx) => {
		const jobs =
			await tx`SELECT id FROM agent_jobs WHERE status='pending' AND (published_at IS NULL OR published_at<now()-interval '1 hour') ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED`;
		if (!jobs.length) return;
		await queue.sendBatch(
			jobs.map((job) => ({
				body: { version: 1, token: job.id },
				contentType: "json",
				delaySeconds: 0,
			})),
		);
		await tx`UPDATE agent_jobs SET published_at=now() WHERE id IN ${tx(jobs.map((job) => job.id))}`;
	});
}
export async function consumeAgentJobs(
	db: Database,
	batch: QueueBatch,
	model: ModelFactory,
) {
	for (const message of batch.messages) {
		const parsed = workMessage.safeParse(message.body);
		if (!parsed.success || parsed.data.version !== 1) {
			message.ack();
			continue;
		}
		try {
			const [job] =
				await db`SELECT * FROM agent_jobs WHERE id=${parsed.data.token} AND status='pending'`;
			if (!job) {
				message.ack();
				continue;
			}
			const [existing] =
				await db`SELECT status,created_at FROM agent_turns WHERE id=${job.id}`;
			if (existing) {
				if (
					existing.status === "running" &&
					existing.created_at > new Date(Date.now() - 180000)
				) {
					message.retry({ delaySeconds: 60 });
					continue;
				}
				// An uncertain/partial run is never replayed: its tools may have saved drafts.
				await db`UPDATE agent_jobs SET status=${existing.status === "complete" ? "complete" : "failed"} WHERE id=${job.id}`;
				message.ack();
				continue;
			}
			const settings = await getSettings(db, job.mailbox_id);
			const [eligible] =
				await db`SELECT e.id FROM emails e WHERE e.mailbox_id=${job.mailbox_id} AND e.id=${job.email_id} AND e.delivery_status='received' AND e.folder_id='inbox'
			 AND NOT EXISTS(SELECT 1 FROM emails d WHERE d.mailbox_id=e.mailbox_id AND d.thread_id=e.thread_id AND d.delivery_status='draft')
			 AND e.id=(SELECT n.id FROM emails n WHERE n.mailbox_id=e.mailbox_id AND n.thread_id=e.thread_id AND n.delivery_status IN ('received','sent') ORDER BY n.date DESC,n.id DESC LIMIT 1)`;
			if (!settings.auto_draft || !eligible) {
				await db`UPDATE agent_jobs SET status='skipped' WHERE id=${job.id}`;
				message.ack();
				continue;
			}
			const run = {
				id: job.id as string,
				mailbox: job.mailbox_id as string,
				emailId: job.email_id as string,
				prompt:
					"Automatically draft a reply to the new email if a reply is appropriate. Read the thread first. Otherwise briefly explain why no draft is needed.",
				actor: "automatic",
				automatic: true,
			};
			const claimed = await claimRun(db, run);
			const ok = await executeRun(db, run, claimed, model);
			await db`UPDATE agent_jobs SET status=${ok ? "complete" : "failed"} WHERE id=${job.id}`;
			message.ack();
		} catch (error) {
			// Busy mailboxes and transient DB failures remain recoverable by queue/cron.
			message.retry({
				delaySeconds:
					error instanceof HTTPException && error.status === 409 ? 30 : 120,
			});
		}
	}
}
