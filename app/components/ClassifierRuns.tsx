import { useState } from "react";
import { RunDialog } from "./TagAutomation";
import api from "~/services/api";
import { classificationError } from "../../shared/jev-budget";
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
	queued: "Queued",
	review: "Needs review",
	blocked: "Blocked before sending",
	skipped: "Skipped",
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
	const [reprocess, setReprocess] = useState(false);
	const [started, setStarted] = useState(false);
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
	const groups = useQuery({
		queryKey: ["tag-groups"],
		queryFn: api.listTagGroups,
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
		refetchInterval: 5000,
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
		<div className="rounded-xl border border-kumo-line bg-kumo-base text-kumo-default overflow-hidden">
			<header className="p-5 border-b border-kumo-line">
				<div className="flex flex-wrap justify-between gap-3">
					<div>
						<h2 className="text-sm font-medium">Classifier runs</h2>
						<p className="text-sm text-kumo-subtle mt-1">
							Classification attempts, including blocked jobs and Jev requests.
						</p>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							variant="primary"
							disabled={!classifiers.data?.length || groups.isPending}
							onClick={() => {
								setStarted(false);
								setReprocess(true);
							}}
						>
							Reprocess emails
						</Button>
						<Button variant="secondary" onClick={() => void runs.refetch()}>
							Refresh
						</Button>
					</div>
				</div>
				{started && (
					<p role="status" className="mt-3 text-sm text-kumo-subtle">
						Reprocessing started. Progress appears below; you can leave this
						page.
					</p>
				)}
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
			{reprocess && (
				<RunDialog
					classifiers={classifiers.data ?? []}
					chooseClassifiers
					initialMailbox={mailbox !== "all" ? mailbox : undefined}
					groupNames={Object.fromEntries(
						(groups.data ?? []).map((g) => [g.id, g.name]),
					)}
					close={() => setReprocess(false)}
					done={(mailboxes) => {
						setReprocess(false);
						setStarted(true);
						changeFilters({
							mailbox: mailboxes.length === 1 ? mailboxes[0] : "all",
							status: "",
							classifier: "",
							thread: "",
							from: "",
							to: "",
						});
						void runs.refetch();
						void classifiers.refetch();
					}}
				/>
			)}
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
								No attempts match these filters. Try changing your filters.
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
										{run.historical ? "Recovered status · " : ""}
										{statusLabels[run.status]}
									</span>
								</div>
								<div className="font-medium text-sm mt-2 break-words">
									{run.subject}
								</div>
								{run.error && (
									<p className="text-xs text-kumo-danger mt-1">
										{classificationError(run.error)}
									</p>
								)}
								<div className="text-xs text-kumo-subtle mt-1 break-words">
									{run.mailbox_id} ·{" "}
									{run.classifiers.map((c) => c.name).join(" + ")}
								</div>
								<div className="flex justify-between text-xs text-kumo-subtle mt-3 gap-3">
									<span>
										{run.classifiers.length} question
										{run.classifiers.length === 1 ? "" : "s"} ·{" "}
										{run.duration_ms === null
											? run.status === "queued"
												? "Waiting to process"
												: run.status === "running"
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
						className="border-t xl:border-t-0 xl:border-l border-kumo-line"
						key={selected}
						id={selected}
						close={() => changeFilters({ run: "" })}
					/>
				)}
			</div>
		</div>
	);
}
