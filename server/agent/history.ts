import {
	convertToModelMessages,
	isToolOrDynamicToolUIPart,
	type ModelMessage,
} from "ai";
import type { AgentTurn, InboxChatMessage } from "../../shared/agent";

function toolInput(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return {};
		}
	}
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
// Keep only portable parts. Provider reasoning signatures and metadata must not
// cross model boundaries. Never mutate the stored message used by the UI.
export function portableHistory(
	message: InboxChatMessage,
	prefix: string,
): InboxChatMessage {
	const parts: InboxChatMessage["parts"] = [];
	for (const part of message.parts) {
		if (part.type === "text" && part.text.trim())
			parts.push({ type: "text", text: part.text.slice(0, 8000) });
		if (!isToolOrDynamicToolUIPart(part)) continue;
		const base = {
			type: "dynamic-tool" as const,
			toolName:
				part.type === "dynamic-tool" ? part.toolName : part.type.slice(5),
			toolCallId: `history_${prefix}_${parts.length}`,
			input: toolInput(part.input),
		};
		if (part.state === "output-available") {
			const output = part.output ?? null;
			const encoded = JSON.stringify(output);
			parts.push({
				...base,
				state: "output-available",
				output:
					encoded.length > 6000
						? { truncated: true, excerpt: encoded.slice(0, 6000) }
						: output,
			});
		} else {
			parts.push({
				...base,
				state: "output-error",
				errorText:
					part.state === "output-error"
						? "The tool failed. Its operation must not be assumed successful."
						: "This tool was interrupted or denied. Check current mailbox state before attempting another change.",
			});
		}
	}
	return {
		id: message.id,
		role: "assistant",
		parts: parts.length
			? parts
			: [{ type: "text", text: "[Response interrupted]" }],
	};
}

export async function buildHistory(
	turns: AgentTurn[],
	contextWindow: number | null,
	currentText: string,
): Promise<ModelMessage[]> {
	// Conservative byte-based estimate, with room for system/tools, new email reads
	// and output. Cap spend even when a provider advertises a huge context window.
	const byteLength = (s: string) => new TextEncoder().encode(s).length;
	const budget = Math.max(
		0,
		Math.min(48000, Math.floor((contextWindow ?? 64000) * 0.75) - 12000) -
			byteLength(currentText),
	);
	const groups: ModelMessage[][] = [];
	let used = 0;
	for (const [index, turn] of [...turns].reverse().entries()) {
		const assistant = turn.ui_message ?? {
			id: turn.id,
			role: "assistant" as const,
			parts: [
				{
					type: "text" as const,
					text:
						turn.answer +
						(turn.actions.length
							? `\nSaved actions: ${JSON.stringify(turn.actions)}`
							: ""),
				},
			],
		};
		const group: ModelMessage[] = [
			{ role: "user", content: turn.prompt.slice(0, 8000) },
			...(await convertToModelMessages([
				portableHistory(assistant, String(index)),
			])),
		];
		if (turn.status !== "complete")
			group.push({
				role: "assistant",
				content: `[Previous turn ${turn.status}. Any saved actions remain in effect; inspect mailbox state before repeating them.]`,
			});
		const size = byteLength(JSON.stringify(group));
		if (used + size > budget) break; // Keep contiguous, complete call/result groups.
		used += size;
		groups.unshift(group);
	}
	const result = groups.flat();
	if (groups.length < turns.length)
		result.unshift({
			role: "system",
			content:
				"Some older conversation context was omitted to fit the context budget. Use mailbox tools to recover facts; do not assume omitted instructions or repeat earlier mutations blindly.",
		});
	return result;
}
