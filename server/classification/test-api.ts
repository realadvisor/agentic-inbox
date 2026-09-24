import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
import { conversationState } from "./state";
import { batchRequests } from "./batch";
import { tagGroupInput, groupQuestion } from "../../shared/tag-groups";
import { askJev, JevError } from "./queue";
import { recentExamples } from "./examples";
import { groupChoice, guard } from "../../shared/jev-request";

const input = z
	.object({
		mailbox_id: z.string().email(),
		thread_id: z.string().uuid(),
		questions: z
			.array(
				z
					.object({
						name: z.string().trim().min(1).max(80),
						question: z.string().trim().min(1).max(8000),
						classifier_id: z.string().uuid().optional(),
					})
					.strict(),
			)
			.min(1)
			.max(10),
		group: tagGroupInput.optional(),
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
		const [size] =
			await db`SELECT count(*)::int AS count,coalesce(sum(length(body)+length(subject)),0)::int AS chars FROM emails WHERE mailbox_id=${data.mailbox_id} AND thread_id=${data.thread_id} AND delivery_status IN ('received','sent')`;
		if (!size.count)
			throw new HTTPException(404, {
				message: "No received or sent messages in this conversation",
			});
		if (size.count > 30 || size.chars > 100000)
			throw new HTTPException(400, {
				message:
					"This conversation exceeds the classifier limit (30 messages or 100,000 characters).",
			});
		const state = await conversationState(db, data.mailbox_id, data.thread_id);
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
		const typedQuestion =
			data.group?.selection === "single" ? groupChoice(data.group) : undefined;
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
					const budget = Math.min(
						12000,
						24000 -
							new TextEncoder().encode(
								JSON.stringify(state) + q.question + guard,
							).length,
					);
					const examples =
						data.include_examples && q.classifier_id
							? await recentExamples(
									db,
									q.classifier_id,
									data.mailbox_id,
									data.thread_id,
									q.question,
									budget,
								)
							: [];
					const result = await askJev(
						key ?? "preview",
						q.question,
						state,
						batch.forJob(index),
						examples,
						typedQuestion,
						q.option,
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
						...(data.execute
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
