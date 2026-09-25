import { z } from "zod";
export const defaultDecisionRules = {
	yes: 0.85,
	no: 0.15,
	confidence: 0.6,
	probability: 0.75,
	margin: 0.2,
};
export const decisionRulesSchema = z
	.object({
		yes: z.number().min(0).max(1).default(0.85),
		no: z.number().min(0).max(1).default(0.15),
		confidence: z.number().min(0).max(1).default(0.6),
		probability: z.number().min(0).max(1).default(0.75),
		score_boundaries: z
			.array(z.number().finite().positive().max(9))
			.max(9)
			.optional(),
		margin: z.number().min(0).max(1).default(0.2),
	})
	.strict()
	.refine((v) => v.no < v.yes, {
		message: "The No threshold must be below the Yes threshold",
		path: ["no"],
	});
export type DecisionRules = z.infer<typeof decisionRulesSchema>;
export const decisionRules = (
	value?: Partial<DecisionRules> | null,
): DecisionRules => ({ ...defaultDecisionRules, ...value });

/** Boundary belongs to the higher level. Defaults are halfway between anchors. */
export function scoreBoundaries(
	levels: number,
	rules?: Partial<DecisionRules> | null,
): number[] {
	return (
		rules?.score_boundaries ??
		Array.from({ length: Math.max(0, levels - 1) }, (_, i) => i + 0.5)
	);
}
export function scoreRange(
	index: number,
	levels: number,
	rules?: Partial<DecisionRules> | null,
) {
	const edges = scoreBoundaries(levels, rules);
	return `${index === 0 ? 0 : edges[index - 1]}–${index === levels - 1 ? levels - 1 : `<${edges[index]}`}`;
}
