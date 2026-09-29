import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { classifierRequest } from "~/services/classifiers";
interface Backfill {
	id: string;
	batch_id: string;
	classifier_id: string;
	name: string;
	status: string;
	revision: number;
	prepared: boolean;
	total: number;
	processed: number;
	pending: number;
	waiting: number;
	skipped: number;
	unchanged: number;
	reused: number;
	failed: number;
	review: number;
	last_progress_at: string;
	created_at: string;
}
export function BackfillProgress({ mailbox }: { mailbox?: string }) {
	const qc = useQueryClient();
	const runs = useQuery({
		queryKey: ["backfills", mailbox],
		queryFn: () =>
			classifierRequest<Backfill[]>(
				"/backfills" +
					(mailbox && mailbox !== "all"
						? "?mailbox=" + encodeURIComponent(mailbox)
						: ""),
			),
		refetchInterval: (query) =>
			query.state.data?.some((r) => r.status === "running") ? 5000 : 30000,
	});
	const cancel = useMutation({
		mutationFn: async (ids: string[]) => {
			for (const id of ids)
				await classifierRequest("/classifiers/" + id + "/cancel", "POST", {});
		},
		onSuccess: () => {
			void qc.invalidateQueries({ queryKey: ["backfills"] });
			void qc.invalidateQueries({ queryKey: ["classifiers"] });
		},
	});
	if (runs.error)
		return (
			<p role="alert" className="p-4 text-sm text-kumo-danger">
				Could not load reprocessing progress: {runs.error.message}
			</p>
		);
	if (!runs.data?.length) return null;
	const batches = new Map<string, Backfill[]>();
	for (const run of runs.data) {
		const group = batches.get(run.batch_id) ?? [];
		group.push(run);
		batches.set(run.batch_id, group);
	}
	return (
		<section
			aria-label="Reprocessing progress"
			className="border-b border-kumo-line p-5 space-y-4"
		>
			<h3 className="text-sm font-semibold">Reprocessing progress</h3>
			{[...batches].map(([id, group]) => {
				const sum = (
					key:
						| "total"
						| "processed"
						| "skipped"
						| "unchanged"
						| "reused"
						| "failed"
						| "pending"
						| "review",
				) => group.reduce((n, r) => n + r[key], 0);
				const total = sum("total"),
					finished = sum("processed") + sum("skipped") + sum("failed");
				const active = group.filter((r) => r.status === "running");
				const prepared = group.every((r) => r.prepared);
				const percent = total
					? Math.round((finished / total) * 100)
					: prepared
						? 100
						: 0;
				const stalled =
					active.length > 0 &&
					active.every(
						(r) => Date.now() - Date.parse(r.last_progress_at) > 120000,
					);
				const state = !prepared
					? "Preparing selection"
					: active.length
						? "Running"
						: group.some((r) => r.status === "cancelled")
							? "Cancelled"
							: sum("failed")
								? "Finished with errors"
								: "Finished";
				return (
					<div
						key={id}
						className="rounded-lg border border-kumo-line p-4 text-sm"
					>
						<div className="flex justify-between gap-4 items-center">
							<div>
								<strong>{state}</strong>
								<span className="text-kumo-subtle ml-2">
									{group.length} tag{group.length === 1 ? "" : "s"} ·{" "}
									{new Date(group[0].created_at).toLocaleString()}
								</span>
							</div>
							{active.length > 0 && (
								<Button
									size="sm"
									disabled={cancel.isPending}
									onClick={() =>
										cancel.mutate(active.map((r) => r.classifier_id))
									}
								>
									Cancel run
								</Button>
							)}
						</div>
						<div className="mt-3 flex justify-between gap-3">
							<span>
								{prepared
									? `${finished.toLocaleString()} / ${total.toLocaleString()} tag evaluations`
									: "Finding matching conversations…"}
							</span>
							<span>{prepared ? `${percent}%` : ""}</span>
						</div>
						<div
							role="progressbar"
							aria-label="Reprocessing progress"
							aria-valuemin={0}
							aria-valuemax={Math.max(1, total)}
							aria-valuenow={prepared ? finished : undefined}
							className="w-full mt-2 h-1.5 overflow-hidden rounded-full bg-kumo-control"
						>
							<div
								className="h-full rounded-full bg-blue-600 transition-all"
								style={{ width: prepared ? `${percent}%` : "30%" }}
							/>
						</div>
						<p className="text-xs text-kumo-subtle mt-2">
							{sum("processed").toLocaleString()} processed ·{" "}
							{sum("unchanged").toLocaleString()} already current ·{" "}
							{sum("reused").toLocaleString()} reused ·{" "}
							{(sum("skipped") - sum("unchanged")).toLocaleString()} other skips
							· {sum("failed").toLocaleString()} failed ·{" "}
							{sum("pending").toLocaleString()} remaining
						</p>
						{sum("review") > 0 && (
							<p className="text-xs mt-1">
								{sum("review").toLocaleString()} results need review.
							</p>
						)}
						{stalled && (
							<p role="status" className="text-xs mt-2 text-kumo-subtle">
								No recent progress. Work is saved; the server will retry.
							</p>
						)}
						<details className="mt-3 text-xs">
							<summary className="cursor-pointer text-kumo-subtle">
								Progress by tag
							</summary>
							<ul className="mt-2 space-y-1">
								{group.map((r) => (
									<li key={r.id} className="flex justify-between gap-4">
										<span>
											{r.name} · v{r.revision}
										</span>
										<span>
											{r.processed + r.skipped + r.failed} / {r.total} ·{" "}
											{r.status}
										</span>
									</li>
								))}
							</ul>
						</details>
					</div>
				);
			})}
			{cancel.error && (
				<p role="alert" className="text-kumo-danger text-sm">
					{cancel.error.message}
				</p>
			)}
		</section>
	);
}
