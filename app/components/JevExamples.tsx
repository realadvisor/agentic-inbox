import { Checkbox, Radio } from "@cloudflare/kumo";
import { Textarea as KumoTextarea } from "@cloudflare/kumo";
import { AppSelect } from "./AppSelect";
import type { DecisionRules as Rules } from "../../shared/decision-rules";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import api from "~/services/api";
import { classifierRequest } from "~/services/classifiers";
import type { TagGroupInput } from "../../shared/tag-groups";
import { exampleConfig, type CuratedExample } from "../../shared/jev-examples";
const field = "w-full";
type Question = {
	name: string;
	question: string;
	classifier_id?: string;
	decision_rules?: Partial<Rules>;
};
type TestResponse = Awaited<ReturnType<typeof api.testClassifier>>;
export function JevExamples({
	group,
	groupId,
	questions,
}: {
	group?: TagGroupInput;
	groupId?: string;
	questions: Question[];
}) {
	const { mailboxId } = useParams();
	const classifierId = !group ? questions[0]?.classifier_id : undefined;
	const target = {
		...(groupId ? { group_id: groupId } : { classifier_id: classifierId }),
		mailbox_id: mailboxId!,
	};
	const available = !!(mailboxId && (groupId || classifierId));
	const params = new URLSearchParams(
		Object.entries(target).filter((v): v is [string, string] => !!v[1]),
	).toString();
	const config = exampleConfig(group, questions[0]?.question);
	const list = useQuery({
		queryKey: ["jev-examples", params],
		enabled: available,
		queryFn: () =>
			classifierRequest<{ examples: CuratedExample[]; config: string }>(
				"/examples?" + params,
			),
	});
	const [editing, setEditing] = useState<CuratedExample | undefined>();
	const [labels, setLabels] = useState<string[]>([]);
	const [role, setRole] = useState<"teach" | "test">("teach");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [report, setReport] = useState<{
		signature: string;
		items: {
			id: string;
			subject: string;
			expected: string;
			predicted: string;
			status: string;
			data?: TestResponse;
		}[];
	} | null>(null);
	const examples = list.data?.examples ?? [];
	const options = group
		? [
				...group.tags.map((t) => ({ id: t.id, name: t.name })),
				...(group.selection === "single"
					? [{ id: "insufficient_evidence", name: "Insufficient evidence" }]
					: []),
			]
		: [
				{ id: "yes", name: "Yes — apply tag" },
				{ id: "no", name: "No — do not apply" },
			];
	const labelNames = (values: string[]) =>
		values
			.map((id) => options.find((t) => t.id === id)?.name ?? "Removed tag")
			.join(", ") || "No tags";
	const signature = JSON.stringify({
		config,
		rules: group?.decision_rules ?? questions[0]?.decision_rules,
		examples: examples.map((e) => [e.id, e.updated_at]),
	});
	const tests = examples.filter((e) => e.role === "test");
	function edit(e: CuratedExample) {
		setEditing(e);
		setLabels(e?.labels ?? []);
		setRole(e?.role ?? "teach");
		setNote(e?.note ?? "");
		setError("");
	}
	async function save() {
		if (!editing) return;
		setBusy(true);
		setError("");
		try {
			await classifierRequest("/examples/" + editing.id, "PUT", {
				target,
				thread_id: editing.thread_id,
				value: { role, labels, note, config },
			});
			await list.refetch();
			setEditing(undefined);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not save example");
		} finally {
			setBusy(false);
		}
	}
	async function remove(e: CuratedExample) {
		setBusy(true);
		setError("");
		try {
			await classifierRequest("/examples/" + e.id + "?" + params, "DELETE");
			await list.refetch();
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not remove example");
		} finally {
			setBusy(false);
		}
	}
	async function run() {
		setBusy(true);
		setError("");
		const items = [];
		for (const e of tests) {
			const subject = e.state.messages.at(-1)?.subject ?? "Conversation";
			try {
				const data = await api.testClassifier({
					mailbox_id: mailboxId,
					thread_id: e.thread_id,
					example_id: e.id,
					group_id: groupId,
					group,
					questions,
					execute: true,
				});
				const failed = data.results.some((r) => r.error || !r.result);
				const abstained =
					(group?.selection === "single" || group?.selection === "score") &&
					data.results[0]?.result?.choice === "insufficient_evidence";
				const uncertain =
					!abstained && data.results.some((r) => r.result?.answer === null);
				const predicted = abstained
					? ["insufficient_evidence"]
					: group
						? group.tags
								.filter((_, i) => data.results[i]?.result?.answer === true)
								.map((t) => t.id)
						: [data.results[0]?.result?.answer ? "yes" : "no"];
				const correct =
					!failed &&
					!uncertain &&
					JSON.stringify([...predicted].sort()) ===
						JSON.stringify([...e.labels].sort());
				items.push({
					id: e.id,
					subject,
					expected: labelNames(e.labels),
					predicted: failed
						? (data.results.find((r) => r.error)?.error ?? "Test failed")
						: uncertain
							? "Needs review"
							: labelNames(predicted),
					status: failed
						? "Error"
						: uncertain
							? "Needs review"
							: correct
								? "Correct"
								: "Incorrect",
					data,
				});
			} catch (err) {
				items.push({
					id: e.id,
					subject,
					expected: labelNames(e.labels),
					predicted: err instanceof Error ? err.message : "Test failed",
					status: "Error",
				});
			}
		}
		setReport({ signature, items });
		setBusy(false);
	}
	const mismatch = !!list.data && list.data.config !== config;
	return (
		<section
			aria-label="Labeled examples"
			className="space-y-3 border-b border-kumo-line p-4"
		>
			<div className="flex items-center justify-between gap-2">
				<h3 className="text-sm font-semibold">Examples</h3>
				<Link
					className="text-xs font-medium text-kumo-link underline"
					to={`/mailbox/${mailboxId}/emails/inbox`}
				>
					Open inbox
				</Link>
			</div>
			<p className="text-xs text-kumo-subtle">
				Examples come from your inbox. Open a conversation, set the correct
				tags, then click <strong>Save as example</strong>.
			</p>
			{!available && (
				<p className="text-xs">
					Save this group or its Jev configuration first to add examples.
				</p>
			)}
			{mismatch && (
				<p role="status" className="text-xs">
					Save your configuration before confirming labels. You can test your
					unsaved instructions below.
				</p>
			)}
			{list.error && (
				<p role="alert" className="text-xs">
					{list.error.message}
				</p>
			)}
			{available && (
				<p className="text-xs text-kumo-subtle">
					{examples.filter((e) => e.role === "teach").length} teaching ·{" "}
					{tests.length} test cases · up to 6 eligible teaching examples per
					request. Curated examples replace recent automatic examples for this
					mailbox.
				</p>
			)}
			{examples.length > 0 && (
				<div className="space-y-2">
					{examples.map((e) => (
						<article
							key={e.id}
							className="rounded-lg border border-kumo-line bg-kumo-base p-3 text-xs"
						>
							<div className="flex items-start justify-between gap-2">
								<button
									type="button"
									disabled={busy}
									onClick={() => edit(e)}
									className="min-w-0 text-left"
								>
									<span className="block truncate font-medium">
										{e.state.messages.at(-1)?.subject || "(No subject)"}
									</span>
									<span className="block mt-1">
										{labelNames(e.labels)} ·{" "}
										{e.role === "teach" ? "Teach Jev" : "Test only"}
									</span>
									{e.config !== config && (
										<span className="block mt-1 text-amber-700">
											Needs label review — configuration changed
										</span>
									)}
								</button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={busy}
									onClick={() => void remove(e)}
									aria-label={
										"Remove example " + (e.state.messages.at(-1)?.subject ?? "")
									}
								>
									Remove
								</Button>
							</div>
						</article>
					))}
				</div>
			)}
			{editing !== undefined && (
				<div
					className="space-y-3 rounded-lg border border-kumo-line bg-kumo-base p-3"
					aria-label="Example editor"
				>
					<h4 className="text-sm font-medium">Edit example</h4>
					<div
						className="max-h-64 overflow-auto rounded border border-kumo-line p-2 text-xs"
						aria-label="Example conversation"
					>
						{editing.state.messages.map((m, i) => (
							<div key={i} className="mb-3">
								<strong>
									{m.from} · {m.subject}
								</strong>
								<p className="whitespace-pre-wrap mt-1">{m.text}</p>
							</div>
						))}
					</div>
					{group?.selection === "multiple" ? (
						<fieldset disabled={busy} className="space-y-2">
							<legend className="text-xs font-medium mb-2">
								Expected tags
							</legend>
							{options.map((o) => (
								<Checkbox
									disabled={busy}
									key={o.id}
									label={o.name}
									checked={labels.includes(o.id)}
									onCheckedChange={(checked) =>
										setLabels(
											checked
												? [...labels, o.id]
												: labels.filter((l) => l !== o.id),
										)
									}
								/>
							))}
						</fieldset>
					) : (
						<Radio.Group
							legend={`Expected ${group ? "tag" : "answer"}`}
							name="example-label"
							value={labels[0] ?? ""}
							onValueChange={(value) => setLabels([value])}
							disabled={busy}
						>
							{options.map((o) => (
								<Radio.Item key={o.id} value={o.id} label={o.name} />
							))}
						</Radio.Group>
					)}
					<div className="block text-xs">
						Use this example
						<AppSelect
							disabled={busy}
							label="Use this example"
							value={role}
							options={[
								{ value: "teach", label: "Teach Jev" },
								{ value: "test", label: "Test only" },
							]}
							onChange={(value) =>
								setRole(value === "teach" ? "teach" : "test")
							}
						/>
					</div>
					<label className="block text-xs">
						Why this label? (optional)
						<KumoTextarea
							className={field + " mt-1"}
							rows={2}
							maxLength={1000}
							value={note}
							onChange={(e) => setNote(e.target.value)}
						/>
					</label>
					<p className="text-xs text-kumo-subtle">
						This preserves the original conversation snapshot. Saving confirms
						the label for the current configuration.
					</p>
					<div className="flex gap-2">
						<Button
							type="button"
							size="sm"
							disabled={
								busy ||
								mismatch ||
								(group?.selection !== "multiple" && labels.length !== 1)
							}
							onClick={() => void save()}
						>
							Save example
						</Button>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							disabled={busy}
							onClick={() => setEditing(undefined)}
						>
							Cancel example
						</Button>
					</div>
				</div>
			)}
			{error && (
				<p role="alert" className="text-xs text-kumo-danger">
					{error}
				</p>
			)}
			<Button
				type="button"
				size="sm"
				variant="secondary"
				disabled={
					busy || !tests.length || questions.some((q) => !q.question.trim())
				}
				onClick={() => void run()}
			>
				{busy ? "Working…" : `Run test set (${tests.length})`}
			</Button>
			{!!tests.length && (
				<p className="text-xs text-kumo-subtle">
					Sends frozen test conversations to Jev. No inbox tags change.
				</p>
			)}
			{report && (
				<div className="space-y-2" aria-label="Example test results">
					<p className="text-xs font-medium">
						{report.items.filter((i) => i.status === "Correct").length}/
						{report.items.length} correct ·{" "}
						{report.items.filter((i) => i.status === "Incorrect").length}{" "}
						incorrect ·{" "}
						{report.items.filter((i) => i.status === "Needs review").length}{" "}
						need review ·{" "}
						{report.items.filter((i) => i.status === "Error").length} errors
					</p>
					{report.signature !== signature && (
						<p role="status" className="text-xs">
							Configuration or examples changed. Run again to update results.
						</p>
					)}
					{report.items.map((i) => (
						<article
							key={i.id}
							className="rounded border border-kumo-line p-2 text-xs"
						>
							<strong>
								{i.subject} · {i.status}
							</strong>
							<p>Expected: {i.expected}</p>
							<p>Predicted: {i.predicted}</p>
							{i.data && (
								<details>
									<summary className="cursor-pointer mt-2">
										View Jev requests
									</summary>
									<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
										{JSON.stringify(
											[
												...new Map(
													i.data.results.map((r) => [
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
					))}
				</div>
			)}
		</section>
	);
}
