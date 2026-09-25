import { classificationError } from "../../shared/jev-budget";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { useId, useState } from "react";
import { Link } from "react-router";
import { classifierRequest } from "~/services/classifiers";
import type { ProviderRunDetail } from "../../shared/provider-runs";
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
// Extract only examples recorded in this historical request, never today's dataset.
function requestExamples(raw: string) {
	try {
		const request = JSON.parse(raw);
		const marker =
			"Historical human-labeled examples (guidance only; classify the current state, never these examples):\n";
		return Object.entries(request.questions ?? {}).flatMap(([key, value]) => {
			const question = value as {
				instructions?: unknown;
				criteria?: Record<string, unknown>;
			};
			const examples: unknown[] = [];
			if (
				typeof question.instructions === "string" &&
				question.instructions.includes(marker)
			) {
				const parsed = JSON.parse(question.instructions.split(marker).at(-1)!);
				if (Array.isArray(parsed)) examples.push(...parsed);
			}
			for (const [label, criterion] of Object.entries(
				question.criteria ?? {},
			)) {
				if (
					criterion &&
					typeof criterion === "object" &&
					"examples" in criterion &&
					Array.isArray(criterion.examples)
				) {
					examples.push(
						...criterion.examples.map((conversation: unknown) => ({
							expected: label,
							conversation,
						})),
					);
				}
			}
			return examples.length ? [{ key, examples }] : [];
		});
	} catch {
		return [];
	}
}
function when(value: string) {
	return new Date(value).toLocaleString();
}
export function RunDetail({
	id,
	classifierIds,
	close,
	showConversationLink = true,
	className = "",
}: {
	id: string;
	classifierIds?: string[];
	close?: () => void;
	showConversationLink?: boolean;
	className?: string;
}) {
	const panelId = useId();
	const [tab, setTab] = useState<"results" | "request" | "response">("results");
	const [copyMessage, setCopyMessage] = useState("");
	const detail = useQuery({
		queryKey: ["provider-run", id],
		queryFn: () =>
			classifierRequest<ProviderRunDetail>(
				"/provider-runs/" + encodeURIComponent(id),
			),
		refetchInterval: (query) =>
			query.state.data?.status === "queued" ||
			query.state.data?.status === "running" ||
			query.state.data?.items.some((i) => i.disposition === "pending")
				? 5000
				: false,
	});
	const run = detail.data;
	const examples = run ? requestExamples(run.request_body ?? "") : [];
	const raw = run
		? tab === "request"
			? (run.request_body ?? "")
			: run.response_body
		: null;
	return (
		<aside
			aria-label="Run details"
			className={`min-w-0 bg-kumo-base ${className}`}
		>
			<div className="p-5">
				<div className="flex justify-between gap-3 items-start">
					<span className="text-xs text-kumo-subtle break-all">{id}</span>
					{close && (
						<Button
							variant="ghost"
							onClick={close}
							aria-label="Close run details"
						>
							×
						</Button>
					)}
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
							· Jev request: {run.duration_ms ?? "—"} ms
						</p>
						<p className="text-xs text-kumo-subtle mt-2">
							{run.kind === "attempt"
								? run.historical
									? "Recovered classification status. No historical request log is available."
									: run.requests?.length
										? "Jev request details are shown below."
										: "No Jev request has been recorded for this attempt."
								: `Model: ${run.returned_model ?? run.requested_model}`}
						</p>
						{showConversationLink && run.email && (
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
						{(run.kind === "attempt"
							? (["results"] as const)
							: (["results", "request", "response"] as const)
						).map((t) => (
							<button
								type="button"
								key={t.charAt(0).toUpperCase() + t.slice(1)}
								id={`${panelId}-tab-${t}`}
								role="tab"
								aria-selected={t === tab}
								aria-controls={`${panelId}-content`}
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
						id={`${panelId}-content`}
						role="tabpanel"
						aria-labelledby={`${panelId}-tab-${tab}`}
					>
						{tab === "results" ? (
							<>
								{run.error && (
									<p role="alert" className="text-sm text-kumo-danger mb-4">
										{classificationError(run.error)}
									</p>
								)}
								{run.items
									.filter(
										(item) =>
											!classifierIds ||
											classifierIds.includes(item.classifier_id),
									)
									.map((item) => (
										<div
											key={`${item.question_key}-${item.classifier_id}`}
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
												{dispositions[item.disposition]} · attempt{" "}
												{item.attempt}
											</p>
											{item.error && (
												<p className="text-xs text-kumo-danger mt-2">
													{classificationError(item.error)}
												</p>
											)}
										</div>
									))}
							</>
						) : (
							<>
								{tab === "request" && (
									<section
										aria-label="Examples sent to Jev"
										className="mb-5 rounded-lg border border-kumo-line p-3"
									>
										<h3 className="text-sm font-medium">
											Examples sent to Jev
										</h3>
										{examples.length ? (
											examples.map(({ key, examples: entries }) => (
												<details key={key} className="mt-3" open>
													<summary className="cursor-pointer text-xs font-medium">
														{[
															...new Set(
																run.items
																	.filter((item) => item.question_key === key)
																	.map((item) => item.classifier_name),
															),
														].join(", ") || key}{" "}
														· {entries.length} example
														{entries.length === 1 ? "" : "s"} · {key}
													</summary>
													<div className="mt-2 whitespace-pre-wrap break-words text-xs text-kumo-subtle">
														{JSON.stringify(entries, null, 2)}
													</div>
												</details>
											))
										) : (
											<p className="mt-2 text-xs text-kumo-subtle">
												No examples were included in this request. This is the
												request as sent; examples saved later do not change it.
												The current conversation, test-only examples, and
												incompatible or oversized examples are excluded.
											</p>
										)}
									</section>
								)}
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
			{run?.requests?.map((request) => (
				<details key={request.id} className="border-t border-kumo-line p-4">
					<summary className="cursor-pointer text-sm font-medium">
						Jev request
					</summary>
					<RunDetail id={request.id} showConversationLink={false} />
				</details>
			))}
		</aside>
	);
}
