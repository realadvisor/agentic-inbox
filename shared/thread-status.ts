import { z } from "zod";

export const threadStatusSchema = z.enum(["open", "done"]);
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
export const statusLabels: Record<ThreadStatus, string> = {
	open: "Open",
	done: "Done",
};
export const statusChangeSchema = z
	.object({
		status: threadStatusSchema,
		revision: z.number().int().min(0).max(2147483646),
		reason: z.string().trim().max(1000).optional(),
	})
	.strict();
export type StatusChange = z.infer<typeof statusChangeSchema>;
export interface ThreadState {
	status: ThreadStatus;
	waiting_reason: string | null;
	follow_up_at: string | null;
	revision: number;
	updated_at: string;
	updated_by: string;
}
export interface ThreadActivity {
	id: string;
	from_status: ThreadStatus | "waiting";
	to_status: ThreadStatus | "waiting";
	actor: string;
	reason: string | null;
	follow_up_at: string | null;
	created_at: string;
	revision: number;
}
export interface ThreadWorkflow extends ThreadState {
	activity: ThreadActivity[];
}
