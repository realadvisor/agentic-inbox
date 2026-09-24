import type { AgentTurn, InboxChatMessage } from "./agent";

export function turnsToMessages(turns: AgentTurn[]): InboxChatMessage[] {
	return turns.flatMap((turn): InboxChatMessage[] => {
		const assistant: InboxChatMessage = turn.ui_message ?? {
			id: `${turn.id}-assistant`,
			role: "assistant",
			parts: [
				...(turn.answer ? [{ type: "text" as const, text: turn.answer }] : []),
				...turn.actions.map((action, index) => {
					let output: unknown = action.result;
					try {
						output = JSON.parse(action.result);
					} catch {
						/* Legacy text result. */
					}
					return {
						type: "dynamic-tool" as const,
						toolName: action.tool,
						toolCallId: `${turn.id}-${index}`,
						state: "output-available" as const,
						input: {},
						output,
					};
				}),
			],
		};
		return [
			{
				id: turn.id,
				role: "user",
				parts: [{ type: "text", text: turn.prompt }],
			},
			{
				...assistant,
				metadata: {
					...assistant.metadata,
					model: turn.model,
					status: turn.status,
				},
			},
		];
	});
}
export function draftIdFromOutput(output: unknown): string | undefined {
	if (typeof output !== "object" || output === null || !("draft_id" in output))
		return;
	return typeof output.draft_id === "string" ? output.draft_id : undefined;
}
