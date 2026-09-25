import { decisionRulesSchema } from "./decision-rules";
import { z } from "zod";

export const tagGroupInput = z
	.object({
		name: z.string().trim().min(1).max(80),
		selection: z.enum(["single", "multiple", "score"]),
		decision_rules: decisionRulesSchema.optional(),
		instructions: z.string().trim().max(2000),
		enabled: z.boolean(),
		revision: z.number().int().positive().optional(),
		tags: z
			.array(
				z
					.object({
						id: z.string().uuid(),
						name: z.string().trim().min(1).max(80),
						description: z.string().trim().max(1000).default(""),
						color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
					})
					.strict(),
			)
			.min(1)
			.max(10),
	})
	.strict()
	.superRefine((group, ctx) => {
		if (group.enabled && !group.instructions.trim())
			ctx.addIssue({
				code: "custom",
				path: ["instructions"],
				message:
					"Add instructions for Jev before enabling automatic assignment.",
			});
		if (group.selection === "score") {
			const edges = group.decision_rules?.score_boundaries;
			if (
				edges &&
				(edges.length !== group.tags.length - 1 ||
					edges.some(
						(v, i) =>
							v >= group.tags.length - 1 || (i > 0 && v <= edges[i - 1]),
					))
			)
				ctx.addIssue({
					code: "custom",
					path: ["decision_rules", "score_boundaries"],
					message:
						"Use one increasing boundary between each level, inside the score range.",
				});
			if (group.tags.length < 2)
				ctx.addIssue({
					code: "custom",
					path: ["tags"],
					message: "An ordered scale needs at least two levels.",
				});
			group.tags.forEach((tag, index) => {
				if (!tag.description.trim())
					ctx.addIssue({
						code: "custom",
						path: ["tags", index, "description"],
						message: "Describe each scale level with concrete criteria.",
					});
			});
		}
		for (const key of ["id", "name"] as const) {
			const values = group.tags.map((tag) => tag[key].toLowerCase());
			if (new Set(values).size !== values.length)
				ctx.addIssue({
					code: "custom",
					message: `Tag ${key === "id" ? "IDs" : "names"} must be unique within the group.`,
				});
		}
	});
export type TagGroupInput = z.infer<typeof tagGroupInput>;
export type TagGroup = TagGroupInput & { id: string; revision: number };

/** Jev's existing noul questions are batched by the classifier worker. */
export function groupQuestion(
	group: TagGroupInput,
	tag: TagGroupInput["tags"][number],
) {
	return `Classify the conversation in the ${JSON.stringify(group.name)} group.\n${group.instructions}\nAvailable tags: ${JSON.stringify(group.tags.map((option) => ({ name: option.name, description: option.description })))}.\n${group.selection !== "multiple" ? "Choose exactly one best-fitting tag; if the evidence is insufficient, return uncertainty." : "Several tags may apply independently."}\nShould ${JSON.stringify(tag.name)} be selected in this group?`;
}
