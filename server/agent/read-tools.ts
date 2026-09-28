import { z } from "zod";

// Use the same parameter names and store implementation as the HTTP list API.
export const agentEmailQuerySchema = z.object({
	query: z.string().max(500).optional(),
	folder: z.string().max(100).optional(),
	page: z.number().int().min(1).max(100000).default(1),
	limit: z.number().int().min(1).max(50).default(20),
	threaded: z.boolean().optional(),
	thread_id: z.string().uuid().optional(),
	tag_ids: z.array(z.string().uuid()).min(1).max(50).optional(),
	tag_match: z.enum(["all", "any"]).optional(),
	score_group: z.string().uuid().optional(),
	status: z.enum(["open", "done"]).optional(),
	needs_review: z.literal(true).optional(),
	is_read: z.boolean().optional(),
	is_starred: z.boolean().optional(),
	has_attachment: z.literal(true).optional(),
	from: z.string().max(320).optional(),
	to: z.string().max(320).optional(),
	subject: z.string().max(500).optional(),
	date_start: z.string().datetime({ offset: true }).optional(),
	date_end: z.string().datetime({ offset: true }).optional(),
	sortColumn: z.enum(["date", "subject", "sender"]).optional(),
	sortDirection: z.enum(["ASC", "DESC"]).optional(),
});
export function emailQueryParams(
	input: z.infer<typeof agentEmailQuerySchema>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(input)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => [
				key,
				Array.isArray(value) ? value.join(",") : String(value),
			]),
	);
}
