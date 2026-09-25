import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { classifierRequest } from "~/services/classifiers";
type Status = {
	pending: number;
	complete: number;
	review: number;
	failed: number;
	skipped: number;
};
export function ReclassifyConversation({
	mailboxId,
	threadId,
}: {
	mailboxId: string;
	threadId: string;
}) {
	const client = useQueryClient();
	const [attempt, setAttempt] = useState(0);
	const path = "/threads/" + encodeURIComponent(mailboxId) + "/" + threadId;
	const status = useQuery({
		queryKey: ["thread-reclassification", mailboxId, threadId, attempt],
		queryFn: () => classifierRequest<Status>(path),
		enabled: attempt > 0,
		refetchInterval: (q) => (q.state.data?.pending ? 500 : false),
	});
	const run = useMutation({
		mutationFn: () =>
			classifierRequest<{ queued: number; protected: number }>(
				path + "/rerun",
				"POST",
				{},
			),
		onSuccess: (result) => {
			if (result.queued) setAttempt((v) => v + 1);
		},
	});
	const pending =
		run.isPending ||
		(attempt > 0 && (status.isPending || !!status.data?.pending));
	useEffect(() => {
		if (!status.data || status.data.pending) return;
		for (const key of [
			"emails",
			"email",
			"thread",
			"search",
			"conversation-provider-runs",
			"classification-results",
		])
			void client.invalidateQueries({ queryKey: [key] });
	}, [status.data, client]);
	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={pending}
				onClick={() => run.mutate()}
				title="Run all configured Jev questions together. Manual tag choices are preserved."
			>
				<ArrowClockwiseIcon size={15} />
				{pending ? "Reclassifying…" : "Reclassify"}
			</Button>
			{run.data && (
				<span role="status" className="basis-full text-xs text-kumo-subtle">
					{!run.data.queued
						? "Manual choices are preserved; no automatic labels to rerun."
						: pending
							? "Classification queued or running…"
							: status.data
								? `Reclassification finished${status.data.review ? ` · ${status.data.review} need review` : ""}${status.data.failed ? ` · ${status.data.failed} failed` : ""}${status.data.skipped ? ` · ${status.data.skipped} skipped` : ""}.`
								: ""}
					{run.data.protected > 0 && run.data.queued > 0
						? " Manual choices were preserved."
						: ""}
				</span>
			)}
			{(run.error || status.error) && (
				<span role="alert" className="basis-full text-xs text-kumo-danger">
					{(run.error || status.error)?.message}
				</span>
			)}
		</>
	);
}
