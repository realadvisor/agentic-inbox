import { HTTPException } from "hono/http-exception";
import type { Database } from "./db";
import type {
	StatusChange,
	ThreadState,
	ThreadActivity,
	ThreadWorkflow,
} from "../shared/thread-status";

type StateRow = Omit<ThreadState, "follow_up_at" | "updated_at"> & {
	follow_up_at: Date | null;
	updated_at: Date;
};
type ActivityRow = Omit<ThreadActivity, "follow_up_at" | "created_at"> & {
	follow_up_at: Date | null;
	created_at: Date;
};
function serializeState(row: StateRow): ThreadState {
	return {
		...row,
		follow_up_at: row.follow_up_at?.toISOString() ?? null,
		updated_at: row.updated_at.toISOString(),
	};
}

export async function getThreadWorkflow(
	db: Database,
	mailbox: string,
	thread: string,
): Promise<ThreadWorkflow> {
	// One statement gives the state and activity a consistent snapshot.
	const [row] = await db<(StateRow & { activity: ThreadActivity[] })[]>`
 SELECT t.*, COALESCE((SELECT json_agg(a ORDER BY a.revision DESC) FROM
  (SELECT id, from_status, to_status, actor, reason, follow_up_at, created_at, revision
   FROM thread_activity WHERE mailbox_id = t.mailbox_id AND thread_id = t.thread_id ORDER BY revision DESC LIMIT 50) a), '[]'::json) AS activity
 FROM conversations t WHERE t.mailbox_id = ${mailbox} AND t.thread_id = ${thread}`;
	if (!row) throw new HTTPException(404, { message: "Conversation not found" });
	return {
		...serializeState(row),
		activity: row.activity.map((event) => ({
			...event,
			created_at: new Date(event.created_at).toISOString(),
			follow_up_at: event.follow_up_at
				? new Date(event.follow_up_at).toISOString()
				: null,
		})),
	};
}

export async function changeThreadStatus(
	db: Database,
	mailbox: string,
	thread: string,
	input: StatusChange,
	actor = "local-synthetic-user",
) {
	return db.begin(async (tx) => {
		const [previous] = await tx<
			StateRow[]
		>`SELECT * FROM conversations WHERE mailbox_id = ${mailbox} AND thread_id = ${thread} FOR UPDATE`;
		if (!previous)
			throw new HTTPException(404, { message: "Conversation not found" });
		if (previous.revision !== input.revision)
			throw new HTTPException(409, {
				message:
					"Conversation changed. Review the latest messages and try again.",
			});
		const [row] = await tx<
			StateRow[]
		>`UPDATE conversations SET status = ${input.status},
   waiting_reason = NULL,
   follow_up_at = NULL,
   revision = revision + 1, updated_at = now(), updated_by = ${actor}
   WHERE mailbox_id = ${mailbox} AND thread_id = ${thread} RETURNING *`;
		await tx<ActivityRow[]>`INSERT INTO thread_activity
   (id, mailbox_id, thread_id, from_status, to_status, actor, reason, follow_up_at, revision)
   VALUES (${crypto.randomUUID()}, ${mailbox}, ${thread}, ${previous.status}, ${input.status}, ${actor}, ${input.reason ?? null}, ${row.follow_up_at}, ${row.revision})`;
		return serializeState(row);
	});
}
