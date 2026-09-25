import {
	decisionRules,
	defaultDecisionRules,
	type DecisionRules as Rules,
} from "../../shared/decision-rules";
export function DecisionRules({
	value,
	onChange,
	choice = false,
}: {
	value?: Partial<Rules>;
	onChange: (value: Rules) => void;
	choice?: boolean;
}) {
	const rules = decisionRules(value);
	const fields: [Exclude<keyof Rules, "score_boundaries">, string][] = choice
		? [
				["confidence", "Minimum confidence"],
				["probability", "Winning option probability"],
				["margin", "Lead over second option"],
			]
		: [
				["yes", "Apply tag at or above"],
				["no", "Remove automatic tag at or below"],
			];
	return (
		<details className="rounded-lg border border-kumo-line p-3">
			<summary className="cursor-pointer text-sm font-medium">
				Automatic decision rules
			</summary>
			<p className="mt-2 text-xs text-kumo-subtle">
				{choice
					? "All three conditions must pass to apply a level or choice. Uncertain results need review."
					: "Probabilities between these thresholds need human review. Manual tags are preserved."}{" "}
				These rules apply after Jev answers.
			</p>
			<div className="mt-3 space-y-3">
				{fields.map(([key, label]) => (
					<label
						key={key}
						className="flex items-center justify-between gap-3 text-sm"
					>
						<span>
							{label}
							{key === "margin" ? " (percentage points)" : ""}
						</span>
						<span className="flex items-center gap-1">
							<input
								aria-label={label}
								type="number"
								required
								min={0}
								max={100}
								step={1}
								value={Math.round(rules[key] * 100)}
								onChange={(e) =>
									onChange({ ...rules, [key]: Number(e.target.value) / 100 })
								}
								className="w-20 rounded-md border border-kumo-line bg-kumo-base p-2 text-sm"
							/>
							{key === "margin" ? "pp" : "%"}
						</span>
					</label>
				))}
			</div>
			{!choice && rules.no >= rules.yes && (
				<p role="alert" className="mt-2 text-xs text-kumo-danger">
					The No threshold must be below the Yes threshold.
				</p>
			)}
			<button
				type="button"
				className="mt-3 text-xs underline"
				onClick={() => onChange({ ...defaultDecisionRules })}
			>
				Restore defaults
			</button>
		</details>
	);
}
