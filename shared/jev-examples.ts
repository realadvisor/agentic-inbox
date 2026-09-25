import type { TagGroupInput } from "./tag-groups";
export type ExampleTarget = { group_id?: string; classifier_id?: string };
export type ExampleState = {
	our_mailbox: string;
	evaluated_at: string;
	timezone: string;
	messages: {
		subject: string;
		text: string;
		from: string;
		direction: string;
		[key: string]: string | number | null;
	}[];
};
export type CuratedExample = ExampleTarget & {
	id: string;
	mailbox_id: string;
	thread_id: string;
	role: "teach" | "test";
	labels: string[];
	note: string;
	state: ExampleState;
	config: string;
	updated_at: string;
};
// Cosmetic edits do not invalidate human labels. Semantic edits require review.
export function exampleConfig(group?: TagGroupInput, question = "") {
	return JSON.stringify(
		group
			? {
					name: group.name.trim(),
					selection: group.selection,
					instructions: group.instructions.trim(),
					tags: [...group.tags]
						.sort((a, b) =>
							group.selection === "score" ? 0 : a.id.localeCompare(b.id),
						)
						.map((t) => ({
							id: t.id,
							name: t.name.trim(),
							description: t.description.trim(),
						})),
				}
			: { question: question.trim() },
	);
}
export function evidenceKey(state: ExampleState) {
	return JSON.stringify(
		state.messages.map((m) => ({
			from: m.from,
			subject: m.subject,
			text: m.text,
			direction: m.direction,
		})),
	);
}
