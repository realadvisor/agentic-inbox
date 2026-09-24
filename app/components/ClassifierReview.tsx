import {
	CLASSIFICATION_YES_THRESHOLD,
	CLASSIFICATION_NO_THRESHOLD,
} from "shared/classification";
import { useState } from "react";
import { Button, Dialog } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { classifierRequest, type Classification } from "~/services/classifiers";
export function ClassifierReview({ results }: { results: Classification[] }) {
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
				["classification-results", "emails", "tags"].map((key) =>
					qc.invalidateQueries({ queryKey: [key] }),
				),
			);
		},
	});
	const pending = results.filter((r) => r.answer === null);
	if (!pending.length) return null;
	return (
		<span
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<button
				className="mt-1.5 text-xs text-kumo-warning rounded-md border border-kumo-line px-2 py-0.5"
				onClick={() => setOpen(true)}
			>
				Needs review{pending.length > 1 ? ` (${pending.length})` : ""}
			</button>
			<Dialog.Root open={open} onOpenChange={setOpen}>
				<Dialog size="sm" className="p-6">
					<Dialog.Title className="text-base font-semibold">
						Review classification
					</Dialog.Title>
					<p className="text-xs text-kumo-subtle mt-2 mb-4">
						Choose an answer for each question below. Nothing is selected yet.
					</p>
					{pending.map((row) => (
						<div
							key={row.classifier_id}
							className="py-4 border-t border-kumo-line"
						>
							<p className="font-medium text-sm">{row.name}</p>
							<p className="text-sm mt-1">{row.question}</p>
							<div className="rounded-md bg-kumo-recessed p-3 mt-3 text-sm">
								<p className="font-medium">Why this needs review</p>
								<p className="text-kumo-subtle mt-1">
									{row.status === "error"
										? "Classification failed, so there is no reliable automatic answer. Answer below or retry from Settings → Tags."
										: row.error === "conversation_too_large"
											? "This conversation exceeds 30 messages or 100,000 characters. It needs a human review because it was not sent to the classifier."
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
							Automatic decisions: Yes at {CLASSIFICATION_YES_THRESHOLD * 100}%
							or above; No at {CLASSIFICATION_NO_THRESHOLD * 100}% or below.
							Probabilities between these thresholds need review.
						</p>
						<p>
							Your answer saves immediately: Yes applies the tag; No removes it.
							New messages may trigger classification again.
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
