import { tool } from "ai";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import type { Database } from "../db";
import type { Run } from "./service";
import { inspectClassifications } from "../classification/inspect";
import { reviewClassification, reviewInput } from "../classification/review";
import { rerunThread } from "../classification/rerun";

type Mutate = (
	name: string,
	callback: (tx: Database) => Promise<unknown>,
	key?: string,
) => Promise<unknown>;
export function classificationTools(db: Database, run: Run, mutate: Mutate) {
	const available = () => {
		if (run.automatic || !run.classification?.enabled)
			throw new HTTPException(403, {
				message: "Classification tools are unavailable",
			});
	};
	return {
		inspect_classifications: tool({
			description:
				"Inspect current recorded classifications for one conversation, including scale definitions, score, confidence, review status and provenance. Explain recorded fields only; no model reasoning is stored. Manual overrides mean results are not applied.",
			inputSchema: z.object({ threadId: z.string().uuid() }).strict(),
			execute: async ({ threadId }) => {
				available();
				return inspectClassifications(db, run.mailbox, threadId);
			},
		}),
		review_classification: tool({
			description:
				"When explicitly asked to correct an independent or multiple-choice tag, record a boolean correction using the revision and token from inspect_classifications. Never self-approve classifications unsolicited. Single-choice and ordered scales require explicit tag selection instead; this tool does not accept numeric scores. Preserves manual overrides. Recorded as agent, not human training data.",
			inputSchema: reviewInput
				.extend({
					threadId: z.string().uuid(),
					classifierId: z.string().uuid(),
				})
				.strict(),
			execute: async ({ threadId, classifierId, ...input }) => {
				available();
				return mutate(
					"review_classification",
					(tx) =>
						reviewClassification(
							tx,
							run.mailbox,
							threadId,
							classifierId,
							input,
							run.actor,
							"agent",
						),
					`review:${threadId}:${classifierId}:${input.token}:${input.answer}`,
				);
			},
		}),
		rerun_classification: tool({
			description:
				"Administrator only. Queue classification again for exactly one conversation when requested. Preserves manual tags and reviewed corrections; never changes global settings. Queued does not mean classification completed.",
			inputSchema: z.object({ threadId: z.string().uuid() }).strict(),
			execute: async ({ threadId }) => {
				available();
				if (!run.classification?.admin)
					throw new HTTPException(403, {
						message: "Only inbox administrators can run classifiers",
					});
				const result = await mutate(
					"rerun_classification",
					async (tx) => {
						const result = await rerunThread(tx, run.mailbox, threadId);
						return {
							thread_id: threadId,
							queued: result.tokens.length,
							protected: result.protected,
						};
					},
					`rerun:${threadId}`,
				);
				// The durable queue remains authoritative; wake-up failures must not undo a committed action.
				try {
					run.classification.kick?.();
				} catch {
					/* periodic queue dispatch retries */
				}
				return result;
			},
		}),
	};
}
