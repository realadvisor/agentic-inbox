import {
	getCatalog,
	refreshCatalog,
	modelIdSchema,
	requireModel,
	type CatalogFetch,
} from "./catalog";
import type { ModelSource } from "../../shared/agent";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
import {
	claimRun,
	startRun,
	getSettings,
	saveSettings,
	settingsSchema,
	type ModelFactory,
} from "./service";
import { consumeStream } from "ai";
import type { InboxChatMessage } from "../../shared/agent";

export interface AgentOptions {
	model?: ModelFactory;
	sources?: ModelSource[];
	fetchCatalog?: CatalogFetch;
	autoDraftAvailable?: boolean;
	actor?: string;
	waitUntil?: (task: Promise<unknown>) => void;
}
export function agentApi(db: Database, options: AgentOptions) {
	const app = new Hono();
	const sources =
		options.sources ?? (options.model ? ["workers" as const] : []);
	app.get("/api/v1/agent/models", async (c) =>
		c.json(await getCatalog(db, sources)),
	);
	app.post("/api/v1/agent/models/refresh", async (c) => {
		await refreshCatalog(db, options.fetchCatalog);
		return c.json(await getCatalog(db, sources));
	});
	app.get("/api/v1/mailboxes/:mailboxId/agent", async (c) => {
		const mailbox = c.req.param("mailboxId");
		const turns = await db`SELECT id,model,prompt,answer,actions,ui_message,
		 CASE WHEN status='running' AND created_at<now()-interval '3 minutes' THEN 'failed' ELSE status END AS status,created_at
		 FROM agent_turns WHERE mailbox_id=${mailbox} ORDER BY created_at DESC LIMIT 30`;
		return c.json({
			available: !!options.model,
			autoDraftAvailable: !!options.autoDraftAvailable,
			settings: await getSettings(db, mailbox),
			catalog: await getCatalog(db, sources),
			turns: turns.reverse(),
		});
	});
	app.put("/api/v1/mailboxes/:mailboxId/agent/settings", async (c) => {
		const input = settingsSchema.parse(await c.req.json());
		const previous = await getSettings(db, c.req.param("mailboxId"));
		if (input.auto_draft || input.model !== previous.model)
			await requireModel(db, input.model, sources);
		if (input.auto_draft && (!options.model || !options.autoDraftAvailable))
			throw new HTTPException(503, {
				message: "Automatic drafting is not configured",
			});
		return c.json(await saveSettings(db, c.req.param("mailboxId"), input));
	});
	app.post("/api/v1/mailboxes/:mailboxId/agent/chat", async (c) => {
		if (!options.model)
			throw new HTTPException(503, { message: "No AI provider is configured" });
		const input = z
			.object({
				id: z.string().uuid(),
				prompt: z.string().trim().min(1).max(8000),
				emailId: z.string().uuid().optional(),
				model: modelIdSchema.optional(),
			})
			.strict()
			.parse(await c.req.json());
		const run = {
			...input,
			mailbox: c.req.param("mailboxId"),
			actor: options.actor ?? "local-synthetic-user",
		};
		await requireModel(
			db,
			input.model ?? (await getSettings(db, run.mailbox)).model,
			sources,
		);
		const settings = await claimRun(db, run);
		try {
			const execution = await startRun(db, run, settings, options.model);
			options.waitUntil?.(execution.completion);
			return execution.result.toUIMessageStreamResponse<InboxChatMessage>({
				generateMessageId: () => `${run.id}-assistant`,
				sendReasoning: false,
				messageMetadata: ({ part }) =>
					part.type === "start" ? { model: settings.model } : undefined,
				onError: (error) =>
					error instanceof Error ? error.message : "The model request failed",
				onFinish: async ({ responseMessage }) => {
					await execution.completion;
					await db`UPDATE agent_turns SET ui_message=${db.json(JSON.parse(JSON.stringify(responseMessage)))} WHERE id=${run.id} AND mailbox_id=${run.mailbox}`;
				},
				// Consume independently of the browser so disconnects cannot lose tool results.
				consumeSseStream: ({ stream }) => {
					const task = consumeStream({ stream });
					options.waitUntil?.(task);
					return task;
				},
				headers: {
					"Cache-Control": "no-store",
					"x-chat-model": settings.model,
				},
			});
		} catch (error) {
			await db`UPDATE agent_turns SET status='failed',answer='Could not start the model. Check provider configuration.' WHERE id=${run.id} AND mailbox_id=${run.mailbox}`;
			await db`UPDATE agent_settings SET active_run=NULL,lease_until=NULL WHERE mailbox_id=${run.mailbox} AND active_run=${run.id}`;
			throw error;
		}
	});
	return app;
}
