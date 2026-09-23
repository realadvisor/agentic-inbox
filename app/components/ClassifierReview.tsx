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
						Your correction is preserved on reruns, until new mail arrives.
					</p>
					{pending.map((row) => (
						<div
							key={row.classifier_id}
							className="py-4 border-t border-kumo-line"
						>
							<p className="font-medium text-sm">{row.name}</p>
							<p className="text-sm mt-1">{row.question}</p>
							{row.status === "error" && (
								<p className="text-xs text-kumo-subtle mt-2">
									Classification failed. Answer manually here, or retry from
									Classifiers.
								</p>
							)}
							<div className="flex gap-2 justify-end mt-3">
								<Button
									size="sm"
									disabled={review.isPending}
									onClick={() => review.mutate({ row, answer: false })}
								>
									No
								</Button>
								<Button
									size="sm"
									variant="primary"
									disabled={review.isPending}
									onClick={() => review.mutate({ row, answer: true })}
								>
									Yes
								</Button>
							</div>
						</div>
					))}
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
