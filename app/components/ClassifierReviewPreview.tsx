import { useState } from "react";
import { Button, Dialog } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	previewRequest,
	type PreviewResult,
} from "~/services/classifier-preview";
export function ClassifierReviewPreview({
	results,
}: {
	results: PreviewResult[];
}) {
	const [open, setOpen] = useState(false);
	const qc = useQueryClient();
	const review = useMutation({
		mutationFn: ({ row, answer }: { row: PreviewResult; answer: boolean }) =>
			previewRequest(
				`/results/${encodeURIComponent(row.mailbox_id)}/${row.thread_id}/${row.classifier_id}`,
				"PUT",
				{ answer, revision: row.revision },
			),
		onSuccess: async () => {
			await Promise.all(
				["preview-results", "emails", "tags"].map((key) =>
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
						Local fixture results · Your correction is preserved on reruns.
					</p>
					{pending.map((row) => (
						<div
							key={row.classifier_id}
							className="py-4 border-t border-kumo-line"
						>
							<p className="font-medium text-sm">{row.name}</p>
							<p className="text-sm mt-1">{row.question}</p>
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
