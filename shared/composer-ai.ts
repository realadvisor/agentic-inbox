import { z } from "zod";
export const composerAiSchema = z
	.object({
		emailId: z.string().uuid().optional(),
		model: z
			.string()
			.min(1)
			.max(200)
			.regex(/^(?:@cf\/)?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/)
			.optional(),
		action: z
			.enum(["draft", "improve", "shorten", "formalize"])
			.default("draft"),
		instructions: z.string().trim().max(2000).default(""),
		body: z.string().max(16000).default(""),
		subject: z.string().max(1000).default(""),
		recipients: z.string().max(2000).default(""),
	})
	.strict()
	.superRefine((input, ctx) => {
		if (input.action === "draft" && !input.emailId && !input.instructions)
			ctx.addIssue({
				code: "custom",
				message: "Describe the email you want to write",
				path: ["instructions"],
			});
		if (input.action !== "draft" && !input.body.trim())
			ctx.addIssue({
				code: "custom",
				message: "Write a message first",
				path: ["body"],
			});
	});
export type ComposerAiInput = z.input<typeof composerAiSchema>;
export interface ComposerAiResult {
	text: string;
	model: string;
}
