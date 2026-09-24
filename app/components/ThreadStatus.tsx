import { Button, Tooltip } from "@cloudflare/kumo";
import {
	InfoIcon,
	CheckIcon,
	ArrowCounterClockwiseIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { statusLabels, type StatusChange } from "shared/thread-status";
import api from "~/services/api";

export function StatusBadge({ status }: { status: keyof typeof statusLabels }) {
	const color = {
		open: "text-kumo-brand",
		done: "text-kumo-success",
	}[status];
	return (
		<span
			className={`inline-flex items-center gap-1.5 text-xs font-medium ${color}`}
		>
			<span aria-hidden="true">{status === "done" ? "✓" : "●"}</span>
			{statusLabels[status]}
		</span>
	);
}

export default function ThreadStatus({
	mailboxId,
	threadId,
}: {
	mailboxId: string;
	threadId: string;
}) {
	const qc = useQueryClient();
	const key = ["thread-status", mailboxId, threadId];
	const query = useQuery({
		queryKey: key,
		queryFn: () => api.getThreadStatus(mailboxId, threadId),
		refetchInterval: 30_000,
	});
	const [historyOpen, setHistoryOpen] = useState(false);
	const mutation = useMutation({
		mutationFn: (input: StatusChange) =>
			api.updateThreadStatus(mailboxId, threadId, input),
		onSettled: async () => {
			await Promise.all([
				qc.invalidateQueries({ queryKey: key }),
				qc.invalidateQueries({ queryKey: ["emails", mailboxId] }),
			]);
		},
	});
	if (query.isError)
		return (
			<div className="p-4 text-sm" role="alert">
				Could not load conversation status.{" "}
				<Button size="sm" onClick={() => query.refetch()}>
					Retry
				</Button>
			</div>
		);
	if (!query.data)
		return <div className="p-4 text-sm text-kumo-subtle">Loading status…</div>;
	const state = query.data;
	return (
		<section
			aria-label="Conversation status"
			className="border-b border-kumo-line px-5 py-3 space-y-3"
		>
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<div className="flex items-center gap-1">
					<StatusBadge status={state.status} />
					<Tooltip
						side="bottom"
						align="start"
						open={historyOpen}
						onOpenChange={(open, details) =>
							setHistoryOpen(details.reason === "trigger-press" ? true : open)
						}
						asChild
						content={
							<div className="max-w-72 text-xs">
								<div className="font-semibold mb-2">Status history</div>
								{state.activity.length ? (
									<ol
										className="max-h-64 overflow-y-auto space-y-3"
										aria-label="Status history"
									>
										{state.activity.map((event) => (
											<li key={event.id}>
												<div>
													{event.actor} ·{" "}
													{event.from_status === "waiting"
														? "Waiting"
														: statusLabels[event.from_status]}{" "}
													→{" "}
													{event.to_status === "waiting"
														? "Waiting"
														: statusLabels[event.to_status]}
												</div>
												{event.reason && <div>{event.reason}</div>}
												{event.follow_up_at && (
													<div>
														Follow up:{" "}
														{new Date(event.follow_up_at).toLocaleString()}
													</div>
												)}
												<time
													className="block opacity-75"
													dateTime={event.created_at}
												>
													{new Date(event.created_at).toLocaleString()}
												</time>
											</li>
										))}
									</ol>
								) : (
									<p>No status changes yet.</p>
								)}
							</div>
						}
					>
						<Button
							size="sm"
							variant="ghost"
							shape="square"
							aria-label="Status information"
							icon={<InfoIcon size={15} />}
							onFocus={() => setHistoryOpen(true)}
							onClick={() => setHistoryOpen(true)}
						/>
					</Tooltip>
				</div>
				<div className="flex gap-2 flex-wrap">
					<Button
						size="sm"
						variant="primary"
						icon={
							state.status === "done" ? (
								<ArrowCounterClockwiseIcon size={16} />
							) : (
								<CheckIcon size={16} />
							)
						}
						disabled={mutation.isPending}
						onClick={() =>
							mutation.mutate({
								status: state.status === "done" ? "open" : "done",
								revision: state.revision,
							})
						}
					>
						{state.status === "done" ? "Reopen" : "Mark done"}
					</Button>
				</div>
			</div>
			{mutation.error && (
				<p className="text-sm text-kumo-destructive" role="alert">
					{mutation.error.message}
				</p>
			)}
		</section>
	);
}
