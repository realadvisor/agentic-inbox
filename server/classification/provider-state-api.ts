import { Hono } from "hono";
import type { Database } from "../db";
import { askJev, JevError } from "./queue";
import { providerState } from "./provider-state";

export function providerStateApi(
	db: Database,
	key?: string,
	transport: typeof fetch = fetch,
	kick?: () => void,
) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
	app.get("/", async (c) => c.json(await providerState(db)));
	app.post("/resume", async (c) => {
		if (!key) return c.json({ error: "Jev is not configured" }, 503);
		const token = crypto.randomUUID();
		const [probe] =
			await db`UPDATE classifier_provider_state SET resume_token=${token},resume_until=now()+interval '60 seconds',resume_error=NULL WHERE singleton AND paused_at IS NOT NULL AND (resume_until IS NULL OR resume_until<=now()) RETURNING pause_version`;
		if (!probe) {
			const state = await providerState(db);
			return state.paused
				? c.json({ ...state, error: "A credit check is already running." }, 409)
				: c.json(state);
		}
		let error: string | null = null;
		try {
			// One synthetic request, deliberately bypassing the pause. No historical
			// email is needed to check billing and a valid model response.
			await askJev(
				key,
				"Does the status equal ready?",
				{ status: "ready" },
				transport,
			);
		} catch (e) {
			error = e instanceof JevError ? e.code : "provider_unavailable";
		}
		const updated =
			await db`UPDATE classifier_provider_state SET paused_at=CASE WHEN ${error}::text IS NULL THEN NULL ELSE paused_at END,resume_error=${error},resume_token=NULL,resume_until=NULL WHERE singleton AND resume_token=${token} AND pause_version=${probe.pause_version} RETURNING singleton`;
		// A later 402 or a newer probe must win over this result.
		if (!updated.length)
			await db`UPDATE classifier_provider_state SET resume_token=NULL,resume_until=NULL WHERE singleton AND resume_token=${token}`;
		const state = await providerState(db);
		if (!state.paused) kick?.();
		return c.json(state);
	});
	return app;
}
