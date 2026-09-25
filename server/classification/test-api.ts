import { decisionRulesSchema } from "../../shared/decision-rules";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
import { conversationState } from "./state";
import { batchRequests } from "./batch";
import { tagGroupInput, groupQuestion } from "../../shared/tag-groups";
import { askJev, JevError } from "./queue";
import {
	curatedQuestion,
	listExamples,
	exampleOwner,
} from "./curated-examples";
import { groupChoice, jevQuestion } from "../../shared/jev-request";

const input = z
	.object({
		mailbox_id: z.string().email(),
		thread_id: z.string().uuid(),
		questions: z
			.array(
				z
					.object({
						decision_rules: decisionRulesSchema.optional(),
						name: z.string().trim().min(1).max(80),
						question: z.string().trim().min(1).max(8000),
						classifier_id: z.string().uuid().optional(),
					})
					.strict(),
			)
			.min(1)
			.max(10),
		group: tagGroupInput.optional(),
		group_id: z.string().uuid().optional(),
		example_id: z.string().uuid().optional(),
		include_examples: z.boolean().default(false),
		execute: z.boolean().default(false),
	})
	.strict();
export function classifierTestApi(
	db: Database,
	key?: string,
	transport: typeof fetch = fetch,
) {
	const app = new Hono();
	app.post("/test", async (c) => {
		const data = input.parse(await c.req.json());
		if (data.execute && !key)
			throw new HTTPException(503, {
				message:
					"Jev testing is unavailable. Configure TYPESAFE_API_KEY on the server.",
			});
		const target = data.group_id
			? { group_id: data.group_id }
			: data.questions.length === 1 && data.questions[0].classifier_id
				? { classifier_id: data.questions[0].classifier_id }
				: undefined;
		if (data.group_id && !data.group)
			throw new HTTPException(400, {
				message: "Group configuration is required",
			});
		if (target) await exampleOwner(db, target);
		const savedExample =
			data.example_id && target
				? (await listExamples(db, target, data.mailbox_id)).find(
						(e) => e.id === data.example_id && e.thread_id === data.thread_id,
					)
				: undefined;
		if (data.example_id && !savedExample)
			throw new HTTPException(404, { message: "Example not found" });
		if (!savedExample) {
			const [size] =
				await db`SELECT count(*)::int AS count,coalesce(sum(length(body)+length(subject)),0)::int AS chars FROM emails WHERE mailbox_id=${data.mailbox_id} AND thread_id=${data.thread_id} AND delivery_status IN ('received','sent')`;
			if (!size.count)
				throw new HTTPException(404, {
					message: "No received or sent messages in this conversation",
				});
			if (size.count > 1000 || size.chars > 10_000_000)
				throw new HTTPException(400, {
					message: "This conversation is too large to process safely.",
				});
		}
		const state =
			savedExample?.state ??
			(await conversationState(db, data.mailbox_id, data.thread_id));

		const questions = data.group
			? data.group.tags.map((t) => ({
					name: t.name,
					question: groupQuestion(data.group!, t),
					option: t.id,
					classifier_id: undefined as string | undefined,
				}))
			: data.questions.map((q) => ({
					...q,
					option: undefined as string | undefined,
				}));
		const requests = new Map<number, unknown>();
		const batch = batchRequests(
			transport,
			questions.length,
			async (url, init, indexes) => {
				const payload = JSON.parse(String(init.body));
				indexes.forEach((i) => requests.set(i, payload));
				return data.execute
					? transport(url, init)
					: Response.json({ answers: {} });
			},
		);

		const results = await Promise.all(
			questions.map(async (q, index) => {
				try {
					const questionTarget =
						target ??
						(q.classifier_id ? { classifier_id: q.classifier_id } : undefined);
					const typedQuestion = questionTarget
						? await curatedQuestion(db, {
								target: questionTarget,
								mailbox: data.mailbox_id,
								thread: data.thread_id,
								state,
								group: data.group,
								question: q.question,
								option: q.option,
								legacy: data.include_examples,
							})
						: data.group?.selection === "single"
							? groupChoice(data.group)
							: jevQuestion(q.question);

					const result = await askJev(
						key ?? "preview",
						q.question,
						state,
						batch.forJob(index),
						[],
						typedQuestion,
						q.option,
						data.group?.decision_rules ??
							("decision_rules" in q ? q.decision_rules : undefined),
					);
					return {
						name: q.name,
						request: requests.get(index),
						...(data.execute ? { result } : {}),
					};
				} catch (error) {
					return {
						name: q.name,
						request: requests.get(index),
						...(data.execute || !requests.has(index)
							? {
									error: error instanceof JevError ? error.code : "Test failed",
								}
							: {}),
					};
				} finally {
					batch.done(index);
				}
			}),
		);
		return c.json({ available: !!key, results });
	});
	return app;
}
