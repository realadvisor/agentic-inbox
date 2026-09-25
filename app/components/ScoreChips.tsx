import type { ConversationScore } from "~/types";
export function ScoreChips({ scores = [] }: { scores?: ConversationScore[] }) {
	return (
		<>
			{scores.map((s) => (
				<span
					key={s.group_id}
					title={`Confidence ${Math.round(s.confidence * 100)}%${s.needs_review ? " · Proposed level needs review" : ""}`}
					className="inline-flex items-center gap-1 rounded-md border border-kumo-line bg-kumo-tint px-2 py-0.5 text-xs tabular-nums"
				>
					{s.name} · {s.score.toFixed(2)}/{s.maximum}
					{s.needs_review && (
						<span className="text-kumo-subtle"> · Needs review</span>
					)}
				</span>
			))}
		</>
	);
}
