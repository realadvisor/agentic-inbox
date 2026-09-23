import { useMailMode } from "./MailMode";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, Select } from "@cloudflare/kumo";
import { PlusIcon, SparkleIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import { useTags } from "~/queries/tags";
import { useMailboxes } from "~/queries/mailboxes";
import { TagChips, TagPicker } from "./ConversationTags";
import api from "~/services/api";
import { classifierRequest, type Classifier } from "~/services/classifiers";
const field =
	"w-full rounded-lg border border-kumo-line bg-kumo-base p-2.5 text-sm";
function useRefresh() {
	const qc = useQueryClient();
	return async () => {
		await Promise.all(
			["classifiers", "classification-results", "tags", "emails", "search"].map(
				(key) => qc.invalidateQueries({ queryKey: [key] }),
			),
		);
	};
}
export function Classifiers() {
	const mode = useMailMode();
	const canManage = !!(
		mode.data?.classifierPreview || mode.data?.canManageClassifiers
	);
	const refresh = useRefresh();
	const classifiers = useQuery({
		queryKey: ["classifiers"],
		queryFn: () => classifierRequest<Classifier[]>("/classifiers"),
		refetchInterval: 5000,
	});
	const [editing, setEditing] = useState<Classifier | null | undefined>();
	const [running, setRunning] = useState<Classifier | null>(null);
	const [saved, setSaved] = useState<Classifier | null>(null);
	const [error, setError] = useState("");
	const toggle = useMutation({
		mutationFn: (c: Classifier) =>
			classifierRequest("/classifiers/" + c.id, "PUT", {
				question: c.question,
				tag_id: c.tag_id,
				mailbox_ids: c.mailbox_ids,
				enabled: !c.enabled,
				revision: c.revision,
				include_reviewed_examples: c.include_reviewed_examples ?? false,
			}),
		onSuccess: refresh,
	});
	const cancel = useMutation({
		mutationFn: (id: string) =>
			classifierRequest("/classifiers/" + id + "/cancel", "POST", {}),
		onSuccess: refresh,
	});
	return (
		<section className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
			<div className="p-5 flex items-center justify-between gap-3">
				<div className="flex gap-3 items-center">
					<div className="p-2.5 rounded-xl bg-kumo-tint">
						<SparkleIcon size={21} />
					</div>
					<div>
						<h2 className="font-semibold text-sm">Classifiers</h2>
						<p className="text-xs text-kumo-subtle mt-0.5">
							Ask a question. Apply a tag when the answer is yes.
						</p>
					</div>
				</div>
				<Button
					size="sm"
					variant="primary"
					disabled={!canManage}
					icon={<PlusIcon />}
					onClick={() => setEditing(null)}
				>
					Classifier
				</Button>
			</div>
			<div className="border-y border-kumo-line bg-kumo-tint px-5 py-3 text-xs text-kumo-subtle">
				{mode.data?.classifierPreview
					? "Local preview uses fixture answers, not Jev."
					: "Active classifiers run on the server after new mail and sent replies. Existing conversations run only when you request it."}
			</div>
			{classifiers.isPending && <p className="p-5">Loading classifiers…</p>}
			{classifiers.data?.map((c) => (
				<div key={c.id} className="px-5 py-5 border-b border-kumo-line">
					<div className="flex gap-4 justify-between items-start flex-wrap sm:flex-nowrap">
						<div className="min-w-0">
							<TagChips
								tags={[{ id: c.tag_id, name: c.name, color: c.color }]}
							/>
							<p className="text-sm mt-2 leading-relaxed">{c.question}</p>
							<p className="text-xs text-kumo-subtle mt-1.5">
								{c.mailbox_ids.length
									? c.mailbox_ids.map((m) => m.split("@")[0]).join(", ")
									: "All mailboxes"}
							</p>
							{c.include_reviewed_examples && (
								<p className="text-xs text-kumo-subtle mt-1">
									Uses recent human examples
								</p>
							)}
						</div>
						<div className="flex gap-2 items-center shrink-0">
							<div className="flex items-center gap-2">
								<span className="text-xs text-kumo-subtle min-w-12 text-right">
									{c.enabled ? "Active" : "Inactive"}
								</span>
								<button
									type="button"
									role="switch"
									aria-label={"Enable " + c.name}
									aria-checked={c.enabled}
									disabled={!canManage || toggle.isPending}
									onClick={() => {
										setEditing(undefined);
										toggle.mutate(c);
									}}
									className={`relative h-5 w-9 shrink-0 rounded-full border-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand disabled:opacity-50 ${c.enabled ? "bg-blue-600" : "bg-slate-400"}`}
								>
									<span
										className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${c.enabled ? "translate-x-4" : "translate-x-0"}`}
									/>
								</button>
							</div>
						</div>
					</div>
					{(c.errors ?? 0) > 0 && (
						<p className="text-xs text-kumo-danger mt-3">
							{c.errors} conversations failed. Use Run on existing to retry.
						</p>
					)}
					{editing?.id === c.id && (
						<Editor
							key={c.id}
							current={c}
							all={classifiers.data ?? []}
							close={() => setEditing(undefined)}
							done={() => {
								setEditing(undefined);
								void refresh();
							}}
						/>
					)}
					<div className="mt-3 flex gap-3 items-center flex-wrap">
						<Button
							size="sm"
							variant="secondary"
							icon={<PencilSimpleIcon size={14} />}
							disabled={!canManage}
							aria-label={"Edit " + c.name}
							onClick={() => setEditing(editing?.id === c.id ? undefined : c)}
						>
							Edit
						</Button>
						{c.run && (
							<>
								<span className="text-xs text-kumo-subtle" role="status">
									{c.run.processed + c.run.skipped + (c.run.failed ?? 0)} of{" "}
									{c.run.total} processed · {c.run.status}
									{c.run.review > 0 ? ` · ${c.run.review} need review` : ""}
									{(c.run.failed ?? 0) > 0
										? ` · ${c.run.failed} failed — run again to retry`
										: ""}
									{c.run.skipped > 0 ? ` · ${c.run.skipped} skipped` : ""}
								</span>
								{c.run.status === "running" && (
									<Button
										size="sm"
										variant="ghost"
										disabled={!canManage || cancel.isPending}
										onClick={() => cancel.mutate(c.id)}
									>
										Cancel run
									</Button>
								)}
							</>
						)}
						<Button
							size="sm"
							variant="secondary"
							className="ml-auto"
							disabled={!canManage || c.run?.status === "running"}
							aria-label={"Run " + c.name + " on existing"}
							onClick={() => setRunning(c)}
						>
							Run on existing
						</Button>
					</div>
				</div>
			))}
			{editing === null && (
				<div className="p-5">
					<h3 className="font-medium mb-3">New classifier</h3>
					<Editor
						current={null}
						all={classifiers.data ?? []}
						close={() => setEditing(undefined)}
						done={(created) => {
							setEditing(undefined);
							setSaved(created);
							void refresh();
						}}
					/>
				</div>
			)}
			{saved && (
				<div
					className="p-5 text-sm flex items-center gap-3 flex-wrap"
					role="status"
				>
					Classifier saved. Run on existing conversations?
					<Button
						size="sm"
						onClick={() => {
							setRunning(saved);
							setSaved(null);
						}}
					>
						Run on existing
					</Button>
					<Button size="sm" variant="ghost" onClick={() => setSaved(null)}>
						Later
					</Button>
				</div>
			)}
			<p className="p-5 text-xs text-kumo-subtle">
				Turning a classifier off clears its automatic tags. Manual choices stay.
			</p>
			{(error || classifiers.error || toggle.error || cancel.error) && (
				<p role="alert" className="p-5 text-sm text-kumo-danger">
					{error ||
						classifiers.error?.message ||
						toggle.error?.message ||
						cancel.error?.message}
				</p>
			)}
			{running && (
				<RunDialog
					classifier={running}
					close={() => setRunning(null)}
					done={async () => {
						setRunning(null);
						setError("");
						await refresh();
					}}
				/>
			)}
		</section>
	);
}
function Editor({
	current,
	all,
	close,
	done,
}: {
	current: Classifier | null;
	all: Classifier[];
	close: () => void;
	done: (c: Classifier) => void;
}) {
	const mode = useMailMode();
	const [includeExamples, setIncludeExamples] = useState(
		current?.include_reviewed_examples ?? false,
	);
	const tags = useTags();
	const mailboxes = useMailboxes();
	const [question, setQuestion] = useState(current?.question ?? "");
	const [tagId, setTagId] = useState(current?.tag_id ?? "");
	const [newTag, setNewTag] = useState(false);
	const [tagName, setTagName] = useState("");
	const [scope, setScope] = useState(
		current?.mailbox_ids.length ? "selected" : "all",
	);
	const [selected, setSelected] = useState(current?.mailbox_ids ?? []);
	const save = useMutation({
		mutationFn: async () => {
			if (!question.trim()) throw new Error("Enter a question.");
			if (scope === "selected" && !selected.length)
				throw new Error("Select at least one mailbox.");
			let target = tagId;
			if (newTag) {
				const existing = tags.data?.find(
					(t) => t.name.toLowerCase() === tagName.trim().toLowerCase(),
				);
				target =
					existing?.id ??
					(await api.createTag({ name: tagName.trim(), color: "#7c3aed" })).id;
				setTagId(target);
				setNewTag(false);
			}
			if (!target) throw new Error("Choose a tag.");
			return classifierRequest<Classifier>(
				"/classifiers" + (current ? "/" + current.id : ""),
				current ? "PUT" : "POST",
				{
					question,
					tag_id: target,
					mailbox_ids: scope === "all" ? [] : selected,
					enabled: current?.enabled ?? false,
					revision: current?.revision,
					include_reviewed_examples: includeExamples,
				},
			);
		},
		onSuccess: done,
	});
	const available = (tags.data ?? []).filter(
		(tag) => !all.some((c) => c.id !== current?.id && c.tag_id === tag.id),
	);
	return (
		<form
			className="bg-kumo-tint rounded-xl p-4 mt-4 space-y-4"
			onSubmit={(e) => {
				e.preventDefault();
				if (!save.isPending) save.mutate();
			}}
		>
			<fieldset disabled={save.isPending} className="space-y-4">
				<label className="block text-sm">
					Question
					<textarea
						autoFocus
						required
						maxLength={4000}
						rows={3}
						className={field + " mt-1.5"}
						value={question}
						onChange={(e) => setQuestion(e.target.value)}
						placeholder="Does this conversation contain a request to delete personal data?"
					/>
				</label>
				<div className="grid sm:grid-cols-2 gap-4">
					<div className="space-y-2">
						<div className="text-sm">Tag to apply</div>
						<TagPicker
							label="Classifier tag"
							placeholder="Choose a tag"
							tags={available}
							value={tagId}
							onChange={(id) => {
								setTagId(id);
								setNewTag(false);
							}}
						/>
						<Button
							type="button"
							size="sm"
							variant="ghost"
							onClick={() => setNewTag(!newTag)}
						>
							+ Create tag
						</Button>
						{newTag && (
							<label className="block text-sm">
								New tag name
								<input
									required
									maxLength={80}
									className={field + " mt-1"}
									value={tagName}
									onChange={(e) => setTagName(e.target.value)}
								/>
							</label>
						)}
					</div>
					<div>
						<Select
							label="Mailboxes"
							className="w-full"
							items={{ all: "All mailboxes", selected: "Selected mailboxes" }}
							value={scope}
							disabled={save.isPending}
							onValueChange={(value) => {
								if (value) setScope(value);
							}}
						>
							<Select.Option value="all">All mailboxes</Select.Option>
							<Select.Option value="selected">Selected mailboxes</Select.Option>
						</Select>
					</div>
				</div>
				{scope === "selected" && (
					<div className="flex gap-4 flex-wrap">
						{mailboxes.data?.map((m) => (
							<label key={m.id} className="text-sm flex items-center gap-2">
								<input
									type="checkbox"
									checked={selected.includes(m.id)}
									onChange={(e) =>
										setSelected(
											e.target.checked
												? [...selected, m.id]
												: selected.filter((x) => x !== m.id),
										)
									}
								/>
								{m.name}
							</label>
						))}
					</div>
				)}
				{!mode.data?.classifierPreview && (
					<label className="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							className="mt-1"
							checked={includeExamples}
							onChange={(e) => setIncludeExamples(e.target.checked)}
						/>
						<span>
							Use recent human examples
							<small className="block text-kumo-subtle mt-1">
								Send up to six recent reviewed or manually tagged conversations
								from the same mailbox to Jev as examples. Includes yes and no
								decisions from the last 30 days, saved as they looked when
								labeled. Collection starts with new decisions; existing mail
								runs only when requested.
							</small>
						</span>
					</label>
				)}
				{save.error && (
					<p role="alert" className="text-sm text-kumo-danger">
						{save.error.message}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button type="button" onClick={close}>
						Cancel
					</Button>
					<Button type="submit" variant="primary" loading={save.isPending}>
						Save
					</Button>
				</div>
			</fieldset>
		</form>
	);
}
function RunDialog({
	classifier,
	close,
	done,
}: {
	classifier: Classifier;
	close: () => void;
	done: () => void;
}) {
	const mailboxes = useMailboxes();
	const mode = useMailMode();
	const [selected, setSelected] = useState<string[] | null>(null);
	const [selection, setSelection] = useState("unprocessed");
	const [reset, setReset] = useState(false);
	const allowed = (mailboxes.data ?? []).filter(
		(m) =>
			!classifier.mailbox_ids.length || classifier.mailbox_ids.includes(m.id),
	);
	const targets = selected ?? allowed.map((m) => m.id);
	const run = useMutation({
		mutationFn: () =>
			classifierRequest("/classifiers/" + classifier.id + "/runs", "POST", {
				mailbox_ids: targets,
				selection,
				reset,
				enable: !classifier.enabled,
			}),
		onSuccess: done,
	});
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !run.isPending) close();
			}}
		>
			<Dialog className="p-6" size="sm">
				<Dialog.Title className="text-base font-semibold">
					Run on existing conversations
				</Dialog.Title>
				<p className="text-sm text-kumo-subtle mt-2 mb-5">
					{classifier.name} · Active conversations only
				</p>
				<form
					className="space-y-5"
					onSubmit={(e) => {
						e.preventDefault();
						run.mutate();
					}}
				>
					<fieldset disabled={run.isPending} className="space-y-5">
						<div>
							<div className="text-sm mb-2">Mailboxes</div>
							<div className="flex flex-wrap gap-4">
								{allowed.map((m) => (
									<label key={m.id} className="flex gap-2 items-center text-sm">
										<input
											type="checkbox"
											checked={targets.includes(m.id)}
											onChange={(e) =>
												setSelected(
													e.target.checked
														? [...targets, m.id]
														: targets.filter((x) => x !== m.id),
												)
											}
										/>
										{m.name}
									</label>
								))}
							</div>
						</div>
						<label className="block text-sm">
							Conversations
							<select
								className={field + " mt-1.5"}
								value={selection}
								onChange={(e) => {
									setSelection(e.target.value);
									setReset(false);
								}}
							>
								<option value="unprocessed">Not yet processed</option>
								<option value="all">All active conversations</option>
							</select>
						</label>
						<label className="flex items-start gap-2 text-sm">
							<input
								className="mt-1"
								type="checkbox"
								checked={reset}
								disabled={selection !== "all"}
								onChange={(e) => setReset(e.target.checked)}
							/>
							<span>
								Reset manual classifier corrections
								<small className="block text-kumo-subtle">
									Ordinary manual tags stay. Choose all active to reset
									corrections.
								</small>
							</span>
						</label>
						{!classifier.enabled && (
							<p className="text-sm text-kumo-subtle">
								This also enables the classifier for future processing.
							</p>
						)}
						<p className="text-xs text-kumo-subtle">
							{mode.data?.classifierPreview
								? "Preview runs use stored fixture answers."
								: "Runs continue after you close this page. Conversation text and metadata are sent to Typesafe.ai. Up to 5,000 conversations per run."}
						</p>
						{run.error && (
							<p role="alert" className="text-sm text-kumo-danger">
								{run.error.message}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<Button type="button" onClick={close}>
								Cancel
							</Button>
							<Button
								type="submit"
								variant="primary"
								disabled={!targets.length}
								loading={run.isPending}
							>
								{classifier.enabled ? "Run" : "Enable & run"}
							</Button>
						</div>
					</fieldset>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
