import { classificationError } from "../../shared/jev-budget";
import { decisionRules } from "../../shared/decision-rules";
import { useState } from "react";
import { Button, Dialog } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { classifierRequest, type Classification } from "~/services/classifiers";
const percentage = (value: number | null | undefined) =>
	value == null
		? "Unavailable"
		: new Intl.NumberFormat("en", {
				style: "percent",
				maximumFractionDigits: 1,
			}).format(value);
export function ThreadClassifierReview({
	mailboxId,
	threadId,
}: {
	mailboxId: string;
	threadId: string;
}) {
	const results = useQuery({
		queryKey: ["classification-results", mailboxId, threadId],
		queryFn: () =>
			classifierRequest<Classification[]>(
				`/results/${encodeURIComponent(mailboxId)}?thread=${encodeURIComponent(threadId)}`,
			),
		refetchInterval: 5000,
	});
	return (
		<ClassifierReview
			results={(results.data ?? []).filter((row) => row.thread_id === threadId)}
			compact
		/>
	);
}
export function ClassifierReview({
	results,
	compact = false,
}: {
	results: Classification[];
	compact?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const qc = useQueryClient();
	const review = useMutation({
		mutationFn: ({ row, answer }: { row: Classification; answer: boolean }) =>
			classifierRequest(
				`/results/${encodeURIComponent(row.mailbox_id)}/${row.thread_id}/${row.classifier_id}`,
				"PUT",
				{ answer, revision: row.revision, token: row.token },
			),
		onSuccess: async () => {
			await Promise.all(
				[
					"classification-results",
					"emails",
					"email",
					"thread",
					"tags",
					"conversation-provider-runs",
				].map((key) => qc.invalidateQueries({ queryKey: [key] })),
			);
		},
	});
	const pending = results.filter((r) => r.answer === null);
	const choices = new Map<string, Classification[]>();
	const binary = pending.filter((row) => {
		if (
			row.group_id &&
			(row.group_selection === "single" || row.group_selection === "score")
		) {
			const key = `${row.mailbox_id}/${row.thread_id}/${row.group_id}`;
			choices.set(key, [...(choices.get(key) ?? []), row]);
			return false;
		}
		return true;
	});
	const count = choices.size + binary.length;
	if (!pending.length) return null;
	return (
		<span
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<button
				type="button"
				className={`${compact ? "" : "mt-1.5 "}text-xs text-kumo-warning rounded-md border border-kumo-line px-2 py-0.5`}
				onClick={() => setOpen(true)}
			>
				Needs review{count > 1 ? ` (${count})` : ""}
			</button>
			<Dialog.Root open={open} onOpenChange={setOpen}>
				<Dialog
					size="sm"
					className="p-4 sm:p-5"
					style={{
						zIndex: 110,
						width: "min(480px, calc(100vw - 24px))",
						minWidth: 0,
						maxHeight: "calc(100dvh - 32px)",
						overflowY: "auto",
						overscrollBehavior: "contain",
					}}
				>
					<Dialog.Title className="text-base font-semibold">
						Review classification
					</Dialog.Title>
					<p className="text-xs text-kumo-subtle mt-2 mb-4">
						Choose an answer for each question below. Nothing is selected yet.
					</p>
					{[...choices].map(([key, rows]) => (
						<div key={key} className="py-4 border-t border-kumo-line">
							<p className="font-medium text-sm">{rows[0].group_name}</p>
							<p className="text-sm mt-1">Which tag is correct?</p>
							<p className="text-xs text-kumo-subtle mt-2">
								Jev confidence:{" "}
								<span className="font-medium text-kumo-default">
									{percentage(rows[0].confidence)}
								</span>
							</p>
							<p className="text-xs text-kumo-subtle mt-1">
								{rows[0].score != null && (
									<>Score {rows[0].score.toFixed(2)} · </>
								)}
								Percentages show each option’s probability. Confidence describes
								Jev’s certainty in the overall choice.
							</p>
							<details className="mt-2 text-xs text-kumo-subtle">
								<summary className="cursor-pointer font-medium">
									Show prompt
								</summary>
								<p className="mt-2 whitespace-pre-wrap break-words">
									{rows[0].group_instructions}
								</p>
							</details>
							<p className="text-xs text-kumo-subtle mt-2">
								Jev could not confidently select one option. Choose the correct
								tag to resolve this group.
							</p>
							<div className="flex flex-wrap gap-2 mt-3">
								{rows.map((row) => (
									<Button
										key={row.classifier_id}
										size="sm"
										variant="secondary"
										disabled={review.isPending}
										onClick={() => review.mutate({ row, answer: true })}
									>
										<span
											aria-hidden="true"
											className="size-2 rounded-full"
											style={{ backgroundColor: row.color }}
										/>
										{row.name}
										<span className="text-kumo-subtle tabular-nums">
											{percentage(row.probability)}
										</span>
									</Button>
								))}
							</div>
						</div>
					))}
					{binary.map((row) => (
						<div
							key={row.classifier_id}
							className="py-4 border-t border-kumo-line"
						>
							<p className="font-medium text-sm">{row.name}</p>
							<details className="mt-2 text-xs text-kumo-subtle">
								<summary className="cursor-pointer font-medium">
									Show prompt
								</summary>
								<p className="mt-2 whitespace-pre-wrap break-words">
									{row.question}
								</p>
							</details>
							<div className="rounded-md bg-kumo-recessed p-3 mt-3 text-sm">
								<p className="font-medium">Why this needs review</p>
								<p className="text-xs text-kumo-subtle">
									Apply at {percentage(decisionRules(row.decision_rules).yes)}{" "}
									or above; remove at{" "}
									{percentage(decisionRules(row.decision_rules).no)} or below.
								</p>
								<p className="text-kumo-subtle mt-1">
									{row.status === "error"
										? "Classification failed, so there is no reliable automatic answer. Answer below or retry from Settings → Tags."
										: row.error
											? classificationError(row.error)
											: row.probability != null
												? `The model estimated a ${new Intl.NumberFormat("en", { style: "percent", maximumFractionDigits: 2 }).format(row.probability)} probability of Yes, which is in the review range.`
												: "No probability is available for this result. A human answer is needed."}
								</p>
							</div>
							<div className="flex gap-2 justify-end mt-3">
								<Button
									size="sm"
									variant="secondary"
									disabled={review.isPending}
									onClick={() => review.mutate({ row, answer: false })}
								>
									No
								</Button>
								<Button
									size="sm"
									variant="secondary"
									disabled={review.isPending}
									onClick={() => review.mutate({ row, answer: true })}
								>
									Yes
								</Button>
							</div>
						</div>
					))}
					<div className="text-xs text-kumo-subtle border-t border-kumo-line pt-4 space-y-2">
						<p>
							Your answer saves immediately. Choosing an option applies that tag
							and replaces the previous selection in its group. New messages may
							trigger classification again.
						</p>
					</div>
					{review.error && (
						<p role="alert" className="text-sm text-kumo-danger">
							{review.error.message}
						</p>
					)}
					<div className="flex justify-end mt-4">
						<Button onClick={() => setOpen(false)}>Close</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</span>
	);
}
