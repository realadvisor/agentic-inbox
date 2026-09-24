import { ClassifierRunFilters } from "~/components/ClassifierRunFilters";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { useMailMode } from "~/components/MailMode";
import { useMailboxes } from "~/queries/mailboxes";
import { classifierRequest, type Classifier } from "~/services/classifiers";
import type {
	ProviderRunPage,
	ProviderRunDetail,
} from "../../shared/provider-runs";

const statusLabels = {
	running: "Running",
	succeeded: "Succeeded",
	failed: "Failed",
	interrupted: "Interrupted",
};
const dispositions = {
	pending: "Awaiting application",
	applied: "Applied",
	review: "Needs review",
	retry: "Retry scheduled",
	discarded: "Discarded — conversation, classifier, or manual decision changed",
	failed: "Failed",
};
function pretty(value: string) {
	try {
		return JSON.stringify(JSON.parse(value), null, 2);
	} catch {
		return value;
	}
}
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
		<div className="text-kumo-default">
			<header className="pb-5 border-b border-kumo-line">
				<div className="flex justify-between gap-3">
					<div>
						<h1 className="text-xl font-semibold">Classifier runs</h1>
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
								className={`w-full text-left p-4 border-b border-kumo-line cursor-pointer ${selected === run.id ? "bg-kumo-fill" : "hover:bg-kumo-tint"}`}
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
function RunDetail({ id, close }: { id: string; close: () => void }) {
	const [tab, setTab] = useState<"results" | "request" | "response">("results");
	const [copyMessage, setCopyMessage] = useState("");
	const detail = useQuery({
		queryKey: ["provider-run", id],
		queryFn: () =>
			classifierRequest<ProviderRunDetail>(
				"/provider-runs/" + encodeURIComponent(id),
			),
		refetchInterval: (query) =>
			query.state.data?.status === "running" ||
			query.state.data?.items.some((i) => i.disposition === "pending")
				? 5000
				: false,
	});
	const run = detail.data;
	const raw = run
		? tab === "request"
			? run.request_body
			: run.response_body
		: null;
	return (
		<aside
			aria-label="Run details"
			className="border-t xl:border-t-0 xl:border-l border-kumo-line min-w-0 bg-kumo-base"
		>
			<div className="p-5">
				<div className="flex justify-between gap-3 items-start">
					<span className="text-xs text-kumo-subtle break-all">{id}</span>
					<Button
						variant="ghost"
						onClick={close}
						aria-label="Close run details"
					>
						×
					</Button>
				</div>
				{detail.isPending && <p>Loading details…</p>}
				{detail.error && (
					<p role="alert" className="text-kumo-danger">
						{detail.error.message}
					</p>
				)}
				{run && (
					<>
						<h2 className="font-medium text-lg mt-2">{run.subject}</h2>
						<p className="text-xs text-kumo-subtle mt-2 break-words">
							{run.mailbox_id} · {when(run.started_at)}
						</p>
						<p className="text-xs text-kumo-subtle mt-2">
							{statusLabels[run.status]} ·{" "}
							{run.http_status ? `HTTP ${run.http_status}` : "No HTTP response"}{" "}
							· {run.duration_ms ?? "—"} ms
						</p>
						<p className="text-xs text-kumo-subtle mt-2">
							Model: {run.returned_model ?? run.requested_model}
						</p>
						{run.email && (
							<Link
								className="text-sm underline inline-block mt-3"
								to={`/mailbox/${encodeURIComponent(run.mailbox_id)}/emails/${run.email.folder_id}?email=${run.email.id}`}
							>
								Open conversation →
							</Link>
						)}
					</>
				)}
			</div>
			{run && (
				<>
					<div
						className="flex gap-4 px-5 border-b border-kumo-line"
						role="tablist"
						aria-label="Run content"
					>
						{(["results", "request", "response"] as const).map((t) => (
							<button
								type="button"
								key={t.charAt(0).toUpperCase() + t.slice(1)}
								id={`run-tab-${t}`}
								role="tab"
								aria-selected={t === tab}
								aria-controls="run-content"
								onClick={() => {
									setTab(t);
									setCopyMessage("");
								}}
								className={`capitalize py-3 text-sm cursor-pointer border-b-2 ${t === tab ? "border-current" : "border-transparent text-kumo-subtle"}`}
							>
								{t.charAt(0).toUpperCase() + t.slice(1)}
							</button>
						))}
					</div>
					<div
						className="p-5"
						id="run-content"
						role="tabpanel"
						aria-labelledby={`run-tab-${tab}`}
					>
						{tab === "results" ? (
							<>
								{run.error && (
									<p role="alert" className="text-sm text-kumo-danger mb-4">
										{run.error}
									</p>
								)}
								{run.items.map((item) => (
									<div
										key={item.question_key}
										className="py-4 border-b border-kumo-line"
									>
										<div className="flex justify-between gap-3">
											<span className="font-medium">
												{item.classifier_name}
											</span>
											<span className="text-xs text-kumo-subtle">
												{item.question_key} · v{item.revision}
											</span>
										</div>
										<p className="text-sm text-kumo-subtle my-2">
											{item.question}
										</p>
										<div className="flex justify-between text-sm">
											<span>
												{item.probability === null
													? "No answer"
													: item.answer === null
														? "Needs review"
														: item.answer
															? "Yes"
															: "No"}
											</span>
											<span>
												{item.probability === null
													? "—"
													: `${(item.probability * 100).toFixed(1)}% yes`}
											</span>
										</div>
										<p className="text-xs text-kumo-subtle mt-2">
											{dispositions[item.disposition]} · attempt {item.attempt}
										</p>
										{item.error && (
											<p className="text-xs text-kumo-danger mt-2">
												{item.error}
											</p>
										)}
									</div>
								))}
							</>
						) : (
							<>
								<div className="flex justify-between items-center gap-3 mb-3">
									<span className="text-xs text-kumo-subtle">
										{tab === "request"
											? "POST api.typesafe.ai/v1/systemone"
											: "Raw provider response"}
									</span>
									<Button
										variant="secondary"
										disabled={raw === null}
										onClick={async () => {
											try {
												await navigator.clipboard.writeText(raw ?? "");
												setCopyMessage("Copied");
											} catch {
												setCopyMessage(
													"Copy unavailable. Select the text below.",
												);
											}
										}}
									>
										Copy JSON
									</Button>
								</div>
								<span role="status" className="text-xs">
									{copyMessage}
								</span>
								<pre className="text-xs whitespace-pre-wrap break-all bg-kumo-recessed border border-kumo-line rounded-md p-3">
									{raw === null ? "No response was received." : pretty(raw)}
								</pre>
							</>
						)}
					</div>
				</>
			)}
		</aside>
	);
}
