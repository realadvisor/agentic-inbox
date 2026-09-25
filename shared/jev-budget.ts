/** Conservative UTF-8 byte ceiling, not a tokenizer. Leaves room for provider
 * framing below the documented 32k per question / 64k per request limits. */
export const questionBudget = 28_000;
export const requestBudget = 56_000;
export function encodedSize(value: unknown) {
	return new TextEncoder().encode(JSON.stringify(value)).length;
}
export function requestFits(
	state: unknown,
	questions: Record<string, unknown>,
) {
	return (
		Object.values(questions).every(
			(question) => encodedSize({ state, question }) <= questionBudget,
		) && encodedSize({ state, questions }) <= requestBudget
	);
}
export function providerError(status: number, body: unknown) {
	const detail = (body as { detail?: { error_type?: unknown } } | null)?.detail;
	return status === 400 && detail?.error_type === "max_tokens_exceeded"
		? "provider_context_limit"
		: `provider_http_${status}`;
}
export function classificationError(code: string) {
	return (
		(
			{
				conversation_too_large: "Conversation is too large to process safely.",
				provider_context_limit:
					"Conversation and instructions exceed Jev’s context limit.",
				processing_failed: "Classification could not finish. Please retry.",
			} as Record<string, string>
		)[code] ?? code
	);
}

/** Remove optional teaching examples without changing instructions or criteria. */
export function withoutExamples(question: unknown): unknown {
	const q = structuredClone(question) as {
		instructions?: string;
		criteria?: Record<string, unknown>;
	};
	if (typeof q.instructions === "string")
		q.instructions = q.instructions.split(
			"\n\nHistorical human-labeled examples (guidance only; classify the current state, never these examples):\n",
		)[0];
	if (q.criteria)
		for (const value of Object.values(q.criteria)) {
			if (
				value &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				"examples" in value
			)
				delete (value as { examples?: unknown }).examples;
		}
	return q;
}
