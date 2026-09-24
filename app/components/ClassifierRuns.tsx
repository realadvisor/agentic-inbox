import { RunDetail } from "./ClassifierRunDetail";
import { ClassifierRunFilters } from "~/components/ClassifierRunFilters";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { useParams, useSearchParams } from "react-router";
import { useMailMode } from "~/components/MailMode";
import { useMailboxes } from "~/queries/mailboxes";
import { classifierRequest, type Classifier } from "~/services/classifiers";
import type { ProviderRunPage } from "../../shared/provider-runs";

const statusLabels = {
	running: "Running",
	succeeded: "Succeeded",
	failed: "Failed",
	interrupted: "Interrupted",
};
function when(value: string) {
	return new Date(value).toLocaleString();
}

export default function ClassifierRuns() {
	const { mailboxId } = useParams();
	const [params, setParams] = useSearchParams();
	const mode = useMailMode();
	const allowed = !!(
		mode.data?.canManageClassifiers && mode.data?.classifiersEnabled
	);
	const mailboxes = useMailboxes();
	const classifiers = useQuery({
		queryKey: ["classifiers"],
		queryFn: () => classifierRequest<Classifier[]>("/classifiers"),
		enabled: allowed,
	});
	const selected = params.get("run");
	const mailbox = params.get("mailbox") ?? mailboxId ?? "";
	const filters = new URLSearchParams();
	for (const name of ["status", "classifier", "thread"])
		if (params.get(name)) filters.set(name, params.get(name)!);
	if (mailbox !== "all" && mailbox) filters.set("mailbox", mailbox);
	for (const name of ["from", "to"]) {
		const date = params.get(name);
		if (date && !Number.isNaN(Date.parse(date))) {
			const d = new Date(date);
			if (name === "to") d.setUTCDate(d.getUTCDate() + 1);
			filters.set(name, d.toISOString());
		}
	}
	const filterKey = filters.toString();
	const runs = useInfiniteQuery({
		queryKey: ["provider-runs", filterKey],
		initialPageParam: null as string | null,
		enabled: allowed,
		queryFn: ({ pageParam }) => {
			const query = new URLSearchParams(filterKey);
			if (pageParam) query.set("cursor", pageParam);
			return classifierRequest<ProviderRunPage>("/provider-runs?" + query);
		},
		getNextPageParam: (page) => page.next_cursor ?? undefined,
	});
	function changeFilters(changes: Record<string, string>) {
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				for (const [name, value] of Object.entries(changes)) {
					if (value) next.set(name, value);
					else next.delete(name);
				}
				next.delete("run");
				return next;
			},
			{ flushSync: true },
		);
	}
	if (mode.isPending) return <p className="p-6">Loading…</p>;
	if (!allowed)
		return (
			<p className="p-6">
				Classifier logs are available to inbox administrators when classifiers
				are enabled.
			</p>
		);
	return (
		<div className="rounded-lg border border-kumo-line bg-kumo-base text-kumo-default overflow-hidden">
			<header className="p-5 border-b border-kumo-line">
				<div className="flex justify-between gap-3">
					<div>
						<h2 className="text-sm font-medium">Classifier runs</h2>
						<p className="text-sm text-kumo-subtle mt-1">
							Every Jev request, including retries and batched questions.
						</p>
					</div>
					<Button variant="secondary" onClick={() => void runs.refetch()}>
						Refresh
					</Button>
				</div>
				<ClassifierRunFilters
					mailbox={mailbox}
					mailboxes={(mailboxes.data ?? []).map((m) => ({
						value: m.id,
						label: m.email,
					}))}
					classifiers={(classifiers.data ?? []).map((c) => ({
						value: c.id,
						label: c.name,
					}))}
					params={params}
					onChange={changeFilters}
				/>
			</header>
			<div
				className={`grid ${selected ? "xl:grid-cols-[minmax(280px,1fr)_minmax(360px,1fr)]" : ""}`}
			>
				<section
					aria-label="Provider runs"
					className={selected ? "min-w-0 hidden xl:block" : "min-w-0"}
				>
					{runs.isPending && <p className="p-6">Loading runs…</p>}
					{runs.error && (
						<p role="alert" className="p-6 text-kumo-danger">
							{runs.error.message}
						</p>
					)}
					{runs.data?.pages[0].runs.length === 0 && (
						<div className="p-8">
							<h2 className="font-medium">No classifier runs yet</h2>
							<p className="text-sm text-kumo-subtle mt-2">
								Only requests made after logging was enabled appear here. Try
								changing your filters.
							</p>
						</div>
					)}
					{runs.data?.pages
						.flatMap((p) => p.runs)
						.map((run) => (
							<button
								type="button"
								key={run.id}
								aria-pressed={selected === run.id}
								onClick={() =>
									setParams((prev) => {
										const next = new URLSearchParams(prev);
										next.set("run", run.id);
										return next;
									})
								}
								className={`w-full text-left p-5 border-b last:border-b-0 border-kumo-line cursor-pointer ${selected === run.id ? "bg-kumo-fill" : "hover:bg-kumo-tint"}`}
							>
								<div className="flex justify-between gap-3 text-xs">
									<span className="text-kumo-subtle">
										{when(run.started_at)}
									</span>
									<span
										className={
											run.status === "failed"
												? "text-kumo-danger"
												: "text-kumo-default"
										}
									>
										{statusLabels[run.status]}
									</span>
								</div>
								<div className="font-medium text-sm mt-2 break-words">
									{run.subject}
								</div>
								<div className="text-xs text-kumo-subtle mt-1 break-words">
									{run.mailbox_id} ·{" "}
									{run.classifiers.map((c) => c.name).join(" + ")}
								</div>
								<div className="flex justify-between text-xs text-kumo-subtle mt-3 gap-3">
									<span>
										{run.classifiers.length} question
										{run.classifiers.length === 1 ? "" : "s"} ·{" "}
										{run.duration_ms === null
											? run.status === "running"
												? "In progress"
												: "—"
											: `${run.duration_ms} ms`}
									</span>
									<span>
										Attempt{" "}
										{Array.from(
											new Set(run.classifiers.map((c) => c.attempt)),
										).join(", ")}
									</span>
								</div>
							</button>
						))}
					{runs.hasNextPage && (
						<div className="p-4">
							<Button
								variant="secondary"
								disabled={runs.isFetchingNextPage}
								onClick={() => void runs.fetchNextPage()}
							>
								{runs.isFetchingNextPage ? "Loading…" : "Load more"}
							</Button>
						</div>
					)}
				</section>
				{selected && (
					<RunDetail
						key={selected}
						id={selected}
						close={() => changeFilters({ run: "" })}
					/>
				)}
			</div>
		</div>
	);
}
