import type { KeyVariables } from "../api-keys";
import { rerunThread } from "./rerun";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
export function rerunApi(
	db: Database,
	admin: boolean,
	kick?: (tokens?: string[]) => void,
) {
	const app = new Hono<{ Variables: KeyVariables }>();
	app.use("/threads/*", async (c, next) => {
		if (
			!admin &&
			!c
				.get("scope")
				?.permissions.includes(
					c.req.method === "GET"
						? "classifications:read"
						: "classifications:run",
				)
		)
			throw new HTTPException(403, {
				message: "Only inbox administrators can run classifiers",
			});
		await next();
	});
	app.get("/threads/:mailbox/:thread", async (c) => {
		const mailbox = z.string().email().parse(c.req.param("mailbox")),
			thread = z.string().uuid().parse(c.req.param("thread"));
		const jobs =
			await db`SELECT j.status,j.error FROM conversation_classifications j JOIN classifiers c ON c.id=j.classifier_id WHERE j.mailbox_id=${mailbox} AND j.thread_id=${thread} AND j.priority=2 AND c.revision=j.revision`;
		return c.json({
			pending: jobs.filter((j) => j.status === "pending").length,
			complete: jobs.filter((j) => j.status === "complete").length,
			review: jobs.filter((j) => j.status === "review").length,
			failed: jobs.filter((j) => j.status === "error").length,
			skipped: jobs.filter((j) => j.status === "skipped").length,
		});
	});
	app.post("/threads/:mailbox/:thread/rerun", async (c) => {
		const mailbox = z.string().email().parse(c.req.param("mailbox")),
			thread = z.string().uuid().parse(c.req.param("thread"));
		const result = await db.begin(async (tx) => {
			return rerunThread(tx as unknown as Database, mailbox, thread);
		});
		if (result.tokens.length) kick?.(result.tokens);
		return c.json(
			{ queued: result.tokens.length, protected: result.protected },
			202,
		);
	});
	return app;
}
