import type { TagGroupInput } from "../../shared/tag-groups";
import { useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import api from "~/services/api";
import type { Email } from "~/types";

type Question = { name: string; question: string; classifier_id?: string };
type Response = Awaited<ReturnType<typeof api.testClassifier>>;
export function JevEmailTest({
	questions,
	examples,
	selection,
	group,
	groupId,
}: {
	questions: Question[];
	examples: boolean;
	selection?: string;
	group?: TagGroupInput;
	groupId?: string;
}) {
	const { mailboxId } = useParams();
	const [search, setSearch] = useState("");
	const [page, setPage] = useState(1);
	const [selected, setSelected] = useState<Email[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [report, setReport] = useState<{
		signature: string;
		executed: boolean;
		items: { email: Email; data?: Response; error?: string }[];
	} | null>(null);
	const signature = JSON.stringify({
		mailboxId,
		questions,
		examples,
		selection,
		group,
		threads: selected.map((e) => e.thread_id),
	});
	const emails = useQuery({
		queryKey: ["jev-test-emails", mailboxId, search, page],
		enabled: !!mailboxId,
		queryFn: () =>
			api.listEmails(mailboxId!, {
				threaded: "true",
				query: search,
				page: String(page),
				limit: "10",
			}),
	});
	const rows = Array.isArray(emails.data)
		? emails.data
		: (emails.data?.emails ?? []);
	const stale = report && report.signature !== signature;
	async function run(execute: boolean) {
		setBusy(true);
		setError("");
		const items = [];
		for (const email of selected) {
			try {
				items.push({
					email,
					data: await api.testClassifier({
						mailbox_id: mailboxId,
						thread_id: email.thread_id,
						questions,
						include_examples: examples,
						group,
						group_id: groupId,
						execute,
					}),
				});
			} catch (e) {
				items.push({
					email,
					error: e instanceof Error ? e.message : "Test failed",
				});
			}
		}
		setReport({ signature, executed: execute, items });
		setBusy(false);
	}
	const invalid =
		!selected.length ||
		!questions.length ||
		questions.some((q) => !q.name.trim() || !q.question.trim());
	return (
		<div className="space-y-3 border-b border-kumo-line p-4">
			<h3 className="text-sm font-semibold">Try on emails</h3>
			<p className="text-xs text-kumo-subtle">
				Select up to 5 conversations in {mailboxId}. Tests use your unsaved
				instructions and never change tags.
			</p>
			<input
				aria-label="Search test emails"
				placeholder="Search subject, sender or content…"
				className="w-full rounded-lg border border-kumo-line bg-kumo-base p-2 text-sm"
				value={search}
				onChange={(e) => {
					setSearch(e.target.value);
					setPage(1);
				}}
			/>
			<div className="max-h-48 overflow-auto rounded-lg border border-kumo-line bg-kumo-base">
				{emails.isPending && (
					<p className="p-3 text-xs">Loading conversations…</p>
				)}
				{emails.error && (
					<p role="alert" className="p-3 text-xs">
						{emails.error.message}
					</p>
				)}
				{rows.map((email) => (
					<label
						key={email.thread_id ?? email.id}
						className="flex cursor-pointer items-start gap-2 border-b border-kumo-line p-2 last:border-0"
					>
						<input
							type="checkbox"
							className="mt-1"
							checked={selected.some((e) => e.thread_id === email.thread_id)}
							disabled={
								busy ||
								!email.thread_id ||
								(!selected.some((e) => e.thread_id === email.thread_id) &&
									selected.length >= 5)
							}
							onChange={(e) =>
								setSelected(
									e.target.checked
										? [...selected, email]
										: selected.filter((v) => v.thread_id !== email.thread_id),
								)
							}
						/>
						<span className="min-w-0 text-xs">
							<span className="block truncate font-medium">
								{email.subject || "(No subject)"}
							</span>
							<span className="block truncate text-kumo-subtle">
								{email.sender} · {new Date(email.date).toLocaleDateString()}
							</span>
						</span>
					</label>
				))}
				{!emails.isPending && !rows.length && (
					<p className="p-3 text-xs">No conversations found.</p>
				)}
			</div>
			<div className="flex items-center justify-between text-xs">
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={page === 1 || emails.isFetching}
					onClick={() => setPage(page - 1)}
				>
					Previous
				</Button>
				<span>
					{selected.length}/5 selected · page {page}
				</span>
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={rows.length < 10 || emails.isFetching}
					onClick={() => setPage(page + 1)}
				>
					Next
				</Button>
			</div>
			<div className="flex gap-2">
				<Button
					type="button"
					variant="secondary"
					size="sm"
					disabled={busy || invalid}
					onClick={() => void run(false)}
				>
					Preview requests
				</Button>
				<Button
					type="button"
					size="sm"
					disabled={busy || invalid}
					onClick={() => void run(true)}
				>
					{busy ? "Working…" : "Test with Jev"}
				</Button>
			</div>
			<p className="text-xs text-kumo-subtle">
				Preview is local. Testing sends the selected conversations to Jev.
				Attachments are excluded.
			</p>
			{error && <p role="alert">{error}</p>}
			{stale && (
				<p role="status" className="text-xs font-medium">
					Configuration or selection changed. Run again to update these results.
				</p>
			)}
			{report?.items.map(({ email, data, error }) => {
				const needsReview =
					data?.results.some((r) => r.error || r.result?.answer === null) ||
					(selection === "single" &&
						(data?.results.filter((r) => r.result?.answer === true).length ??
							0) > 1);
				return (
					<article
						key={email.thread_id}
						className="space-y-2 rounded-lg border border-kumo-line bg-kumo-base p-3"
					>
						<h4 className="text-sm font-medium">{email.subject}</h4>
						{error && (
							<p role="alert" className="text-xs text-red-600">
								{error}
							</p>
						)}
						{data && !data.available && (
							<p className="text-xs">
								Preview available. To run tests, configure TYPESAFE_API_KEY on
								the server.
							</p>
						)}
						{report.executed && data && (
							<>
								<p className="text-xs font-medium">
									{needsReview
										? "Needs review — uncertain or conflicting predictions"
										: "Test predictions"}
									{stale ? " (out of date)" : ""}
								</p>
								{data.results[0]?.result?.confidence !== undefined && (
									<p className="text-xs text-kumo-subtle">
										Choice confidence:{" "}
										{Math.round(data.results[0].result.confidence * 100)}%.{" "}
										{data.results[0].result.choice === "insufficient_evidence"
											? "Insufficient evidence — review required."
											: "Probabilities below show support for each tag."}
									</p>
								)}
								{data.results.map((r, i) => (
									<p key={i} className="flex justify-between gap-2 text-xs">
										<span>{r.name}</span>
										<span>
											{r.error ??
												(r.result
													? `${r.result.answer === null ? "Uncertain" : r.result.answer ? "Yes" : "No"} · ${Math.round(r.result.probability * 100)}%`
													: "")}
										</span>
									</p>
								))}
							</>
						)}
						{data && (
							<details>
								<summary className="cursor-pointer text-xs font-medium">
									{report.executed ? "View sent requests" : "View requests"} (
									{
										new Set(data.results.map((r) => JSON.stringify(r.request)))
											.size
									}
									)
								</summary>
								<p className="my-2 text-xs text-kumo-subtle">
									Questions share the same conversation. Single-selection groups
									use one Choice question.
								</p>
								<pre
									aria-label={`Jev requests for ${email.subject}`}
									className="max-h-80 overflow-auto text-xs whitespace-pre-wrap break-words"
								>
									{JSON.stringify(
										[
											...new Map(
												data.results.map((r) => [
													JSON.stringify(r.request),
													r.request,
												]),
											).values(),
										],
										null,
										2,
									)}
								</pre>
							</details>
						)}
					</article>
				);
			})}
		</div>
	);
}
