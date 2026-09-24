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
	executeRun,
	getSettings,
	saveSettings,
	settingsSchema,
	type ModelFactory,
} from "./service";
import type { AgentEvent } from "../../shared/agent";

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
		const turns = await db`SELECT id,model,prompt,answer,actions,
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
		let disconnected = false;
		let task: Promise<unknown> | undefined;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const emit = (event: AgentEvent) => {
					if (!disconnected)
						controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
				};
				task = executeRun(db, run, settings, options.model!, emit)
					.catch(() => {
						emit({
							type: "error",
							message:
								"The agent was interrupted. Reload its history before trying again.",
						});
					})
					.finally(() => {
						if (!disconnected) controller.close();
					});
			},
			cancel() {
				disconnected = true;
			},
		});
		// Keep the request's DB alive until streamed work and persistence finish.
		options.waitUntil?.(task!);
		return new Response(stream, {
			headers: {
				"Content-Type": "application/x-ndjson",
				"Cache-Control": "no-store",
			},
		});
	});
	return app;
}
