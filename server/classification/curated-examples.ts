import { requestFits } from "../../shared/jev-budget";
import { HTTPException } from "hono/http-exception";
import type { Database } from "../db";
import type { TagGroupInput } from "../../shared/tag-groups";
import {
	exampleConfig,
	evidenceKey,
	type CuratedExample,
	type ExampleState,
	type ExampleTarget,
} from "../../shared/jev-examples";
import {
	groupChoice,
	jevQuestion,
	jevRequest,
	type JevQuestion,
} from "../../shared/jev-request";
import { recentExamples } from "./examples";

export async function exampleOwner(db: Database, target: ExampleTarget) {
	if (target.group_id) {
		const [group] =
			await db`SELECT g.*, (SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color,'description',t.description) ORDER BY t.position,t.id) FROM tags t WHERE t.group_id=g.id AND t.archived_at IS NULL) AS tags FROM tag_groups g WHERE g.id=${target.group_id}`;
		if (!group) throw new HTTPException(404, { message: "Group not found" });
		return {
			group: group as TagGroupInput,
			question: "",
			config: exampleConfig(group as TagGroupInput),
		};
	}
	const [c] =
		await db`SELECT c.question FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE c.id=${target.classifier_id!} AND t.group_id IS NULL AND t.archived_at IS NULL`;
	if (!c)
		throw new HTTPException(404, {
			message: "Standalone classifier not found",
		});
	return {
		group: undefined,
		question: c.question as string,
		config: exampleConfig(undefined, c.question),
	};
}
export async function listExamples(
	db: Database,
	target: ExampleTarget,
	mailbox: string,
) {
	return db<
		CuratedExample[]
	>`SELECT * FROM jev_examples WHERE mailbox_id=${mailbox} AND ${target.group_id ? db`group_id=${target.group_id}` : db`classifier_id=${target.classifier_id!}`} ORDER BY updated_at DESC,id`;
}
export async function curatedQuestion(
	db: Database,
	options: {
		target: ExampleTarget;
		mailbox: string;
		thread: string;
		state: ExampleState;
		group?: TagGroupInput;
		question: string;
		option?: string;
		legacy?: boolean;
	},
) {
	const { target, mailbox, thread, state, group, question, option } = options;
	const config = exampleConfig(group, question);
	let base: JevQuestion =
		group?.selection === "single" ? groupChoice(group) : jevQuestion(question);
	const rows = await listExamples(db, target, mailbox);
	const seen = new Set([evidenceKey(state)]);
	const selected: CuratedExample[] = [];
	const counts = new Map<string, number>();
	// Round-robin by label so the newest/common label cannot occupy all six slots.
	const ranks = new Map<string, number>();
	const candidates = rows
		.filter(
			(e) =>
				e.role === "teach" && e.config === config && e.thread_id !== thread,
		)
		.map((e) => {
			const key = JSON.stringify(e.labels),
				rank = ranks.get(key) ?? 0;
			ranks.set(key, rank + 1);
			return { e, rank };
		})
		.sort((a, b) => a.rank - b.rank)
		.map((v) => v.e);

	for (const e of candidates) {
		const key = evidenceKey(e.state),
			label = JSON.stringify(e.labels);
		if (seen.has(key) || (counts.get(label) ?? 0) >= 3) continue;
		const next = [...selected, e];
		const trial = withExamples(base, next, group ? option : undefined);
		if (
			new TextEncoder().encode(
				JSON.stringify(
					next.map((x) => ({ labels: x.labels, state: x.state, note: x.note })),
				),
			).length > 12000 ||
			!requestFits(state, { match: trial })
		)
			continue;
		selected.push(e);
		seen.add(key);
		counts.set(label, (counts.get(label) ?? 0) + 1);
		if (selected.length === 6) break;
	}
	if (selected.length)
		return withExamples(base, selected, group ? option : undefined);
	// Curated held-out conversations must never leak through the legacy examples path.
	if (options.legacy && target.classifier_id && !rows.length) {
		const budget = Math.min(
			12000,
			24000 -
				new TextEncoder().encode(
					JSON.stringify(jevRequest(state, { match: base })),
				).length,
		);
		base = jevQuestion(
			question,
			await recentExamples(
				db,
				target.classifier_id,
				mailbox,
				thread,
				question,
				budget,
			),
		);
	}
	return base;
}
function withExamples(
	base: JevQuestion,
	examples: CuratedExample[],
	option?: string,
): JevQuestion {
	const evidence = examples.map((e) => ({
		conversation: e.state,
		expected:
			base.type === "choice"
				? e.labels[0]
				: option
					? e.labels.includes(option)
					: e.labels.includes("yes"),
		explanation: e.note,
	}));
	return {
		...base,
		instructions:
			base.instructions +
			"\n\nHistorical human-labeled examples (guidance only; classify the current state, never these examples):\n" +
			JSON.stringify(evidence),
	};
}
