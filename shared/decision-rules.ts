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
