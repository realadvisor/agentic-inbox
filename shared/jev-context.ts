import { encodedSize, requestFits } from "./jev-budget";

// Recovery applies only to message-shaped inputs, never arbitrary caller state.
export const oversizedContextBytes = 80_000;
export function cropConversation(
	state: unknown,
	questions: Record<string, unknown>,
): unknown {
	if (
		!state ||
		typeof state !== "object" ||
		!("messages" in state) ||
		!Array.isArray(state.messages) ||
		!state.messages.length
	)
		return state;
	const original = state.messages as unknown[];
	if (
		!original.every(
			(m) =>
				m && typeof m === "object" && "text" in m && typeof m.text === "string",
		)
	)
		return state;
	const messages = original as Record<string, unknown>[];
	// No middle history is mistaken for the current reply: retain chronological order.
	const indices = [...new Set([0, ...messages.map((_, i) => i).slice(-4)])];
	const clean = (text: string) =>
		text
			.replace(/\u034f/g, "")
			.replace(/[\t \u00a0]+/g, " ")
			.replace(/^ +| +$/gm, "")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
	for (
		let allowance = 3000;
		allowance >= 96;
		allowance = Math.floor(allowance / 2)
	) {
		const kept = indices.map((i) => {
			const message = messages[i];
			const text = clean(message.text as string);
			const points = Array.from(text);
			const truncated = points.length > allowance;
			const head = Math.ceil(allowance * 0.8);
			return {
				...message,
				text: truncated
					? points.slice(0, head).join("") +
						"\n[Middle of message omitted]\n" +
						points.slice(-(allowance - head)).join("")
					: text,
				context_excerpt: {
					original_index: i,
					original_characters: (message.text as string).length,
					cropped: truncated,
				},
			};
		});
		const result = {
			...state,
			messages: kept,
			context_preparation: {
				version: 1,
				cropped: true,
				original_messages: messages.length,
				omitted_messages: messages.length - kept.length,
				notice:
					"Incomplete conversation excerpts: first message and most recent messages retained; message middles or older messages may be omitted. Missing history is not evidence that a request was absent or resolved.",
			},
		};
		if (requestFits(result, questions)) return result;
	}
	// Metadata/instructions themselves may be too large; never loop or silently erase them.
	return state;
}
export function prepareOversizedContext(
	state: unknown,
	questions: Record<string, unknown>,
) {
	return encodedSize(state) > oversizedContextBytes
		? cropConversation(state, questions)
		: state;
}
