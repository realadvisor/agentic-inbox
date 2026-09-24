import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog } from "@cloudflare/kumo";
import { useMutation } from "@tanstack/react-query";
import { useTagMutation } from "~/queries/tags";
import { useMailboxes } from "~/queries/mailboxes";
import { useMailMode } from "./MailMode";
import { classifierRequest, type Classifier } from "~/services/classifiers";
const field =
	"w-full rounded-lg border border-kumo-line bg-kumo-base p-2.5 text-sm";
export function useTagClassifiers() {
	const mode = useMailMode();
	const available = !!(
		mode.data?.classifierPreview || mode.data?.classifiersEnabled
	);
	const canManage =
		available &&
		!!(mode.data?.classifierPreview || mode.data?.canManageClassifiers);
	const query = useQuery({
		queryKey: ["classifiers"],
		queryFn: () => classifierRequest<Classifier[]>("/classifiers"),
		enabled: available,
		refetchInterval: 5000,
	});
	return { ...query, available, canManage };
}
export type AutomationDraft = {
	enabled: boolean;
	question: string;
	mailbox_ids: string[];
	include_reviewed_examples: boolean;
};
export function automationDraft(c?: Classifier): AutomationDraft {
	return {
		enabled: c?.enabled ?? false,
		question: c?.question ?? "",
		mailbox_ids: c?.mailbox_ids ?? [],
		include_reviewed_examples: c?.include_reviewed_examples ?? false,
	};
}
export function AutomationFields({
	value,
	onChange,
	onValidityChange,
	disabled,
}: {
	value: AutomationDraft;
	onChange: (value: AutomationDraft) => void;
	onValidityChange: (valid: boolean) => void;
	disabled: boolean;
}) {
	const mailboxes = useMailboxes();
	const [scope, setScope] = useState(
		value.mailbox_ids.length ? "selected" : "all",
	);
	useEffect(() => {
		onValidityChange(
			!value.enabled || scope === "all" || value.mailbox_ids.length > 0,
		);
	}, [value.enabled, value.mailbox_ids.length, scope, onValidityChange]);
	return (
		<fieldset
			disabled={disabled}
			className="space-y-4 border-t border-kumo-line pt-4"
		>
			<label className="flex items-center gap-2 text-sm font-medium">
				<input
					type="checkbox"
					checked={value.enabled}
					onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
				/>
				Assign automatically with Jev
			</label>
			{value.enabled && (
				<>
					<label className="block text-sm font-medium">
						Instructions for Jev
						<textarea
							required
							maxLength={4000}
							rows={10}
							className={field + " mt-2 min-h-60 font-normal leading-relaxed"}
							value={value.question}
							onChange={(e) => onChange({ ...value, question: e.target.value })}
							placeholder="Should this conversation receive this tag? Describe when it applies."
						/>
					</label>
					<details>
						<summary className="cursor-pointer text-xs text-kumo-subtle">
							More options
						</summary>
						<div className="mt-3 space-y-3">
							<label className="block text-sm">
								Mailboxes
								<select
									className={field + " mt-1"}
									value={scope}
									onChange={(e) => {
										setScope(e.target.value);
										if (e.target.value === "all")
											onChange({ ...value, mailbox_ids: [] });
									}}
								>
									<option value="all">All mailboxes</option>
									<option value="selected">Selected mailboxes</option>
								</select>
							</label>
							{scope === "selected" && (
								<div className="space-y-2">
									{mailboxes.data?.map((m) => (
										<label
											key={m.id}
											className="flex items-center gap-2 text-sm"
										>
											<input
												type="checkbox"
												checked={value.mailbox_ids.includes(m.id)}
												onChange={(e) =>
													onChange({
														...value,
														mailbox_ids: e.target.checked
															? [...value.mailbox_ids, m.id]
															: value.mailbox_ids.filter((id) => id !== m.id),
													})
												}
											/>
											{m.name}
										</label>
									))}
									{!value.mailbox_ids.length && (
										<p role="alert" className="text-xs text-kumo-danger">
											Choose a mailbox, or select All mailboxes.
										</p>
									)}
								</div>
							)}
							<label className="flex items-start gap-2 text-sm">
								<input
									type="checkbox"
									checked={value.include_reviewed_examples}
									onChange={(e) =>
										onChange({
											...value,
											include_reviewed_examples: e.target.checked,
										})
									}
								/>
								Use recent human examples
							</label>
							<p className="text-xs text-kumo-subtle">
								Includes up to six recently reviewed conversations from the same
								mailbox in Jev requests.
							</p>
						</div>
					</details>
				</>
			)}
			<p className="text-xs text-kumo-subtle">
				Saving does not process existing conversations. Turning this off clears
				automatic tags; manual choices stay.
			</p>
		</fieldset>
	);
}
export function ExistingConversations({
	classifiers,
	disabled = false,
}: {
	classifiers: Classifier[];
	disabled?: boolean;
}) {
	const [running, setRunning] = useState(false);
	const cancel = useTagMutation(async () => {
		for (const c of classifiers.filter((c) => c.run?.status === "running"))
			await classifierRequest("/classifiers/" + c.id + "/cancel", "POST", {});
	});
	const active = classifiers.some((c) => c.run?.status === "running");
	return (
		<div className="space-y-3 border-t border-kumo-line pt-4">
			{classifiers
				.filter((c) => c.run)
				.map((c) => (
					<p key={c.id} className="text-xs text-kumo-subtle" role="status">
						{classifiers.length > 1 ? `${c.name}: ` : ""}
						{c.run!.processed + c.run!.skipped + (c.run!.failed ?? 0)} of{" "}
						{c.run!.total} processed · {c.run!.status}
						{c.run!.review ? ` · ${c.run!.review} need review` : ""}
						{c.run!.failed ? ` · ${c.run!.failed} failed` : ""}
					</p>
				))}
			<Button
				type="button"
				size="sm"
				variant="secondary"
				disabled={
					disabled ||
					active ||
					!classifiers.length ||
					classifiers.some((c) => !c.enabled)
				}
				onClick={() => setRunning(true)}
			>
				Apply to existing conversations
			</Button>
			{active && (
				<Button
					type="button"
					size="sm"
					variant="ghost"
					disabled={cancel.isPending}
					onClick={() => cancel.mutate()}
				>
					Cancel run
				</Button>
			)}
			{disabled && (
				<p className="text-xs text-kumo-subtle">
					Save your changes before starting a run.
				</p>
			)}
			{classifiers.some((c) => !c.enabled) && !disabled && (
				<p className="text-xs text-kumo-subtle">
					Enable Jev assignment and save before starting a run.
				</p>
			)}
			{cancel.error && (
				<p role="alert" className="text-xs text-kumo-danger">
					{cancel.error.message}
				</p>
			)}
			{running && (
				<RunDialog
					classifiers={classifiers}
					close={() => setRunning(false)}
					done={() => {
						setRunning(false);
					}}
				/>
			)}
		</div>
	);
}
function RunDialog({
	classifiers,
	close,
	done,
}: {
	classifiers: Classifier[];
	close: () => void;
	done: () => void;
}) {
	const mailboxes = useMailboxes();
	const mode = useMailMode();
	const [selected, setSelected] = useState<string[] | null>(null);
	const [selection, setSelection] = useState("unprocessed");
	const [reset, setReset] = useState(false);
	const allowed = (mailboxes.data ?? []).filter((m) =>
		classifiers.every(
			(c) => !c.mailbox_ids.length || c.mailbox_ids.includes(m.id),
		),
	);
	const targets = selected ?? allowed.map((m) => m.id);
	const [started, setStarted] = useState<string[]>([]);
	const run = useMutation({
		mutationFn: async () => {
			for (const classifier of classifiers) {
				if (started.includes(classifier.id)) continue;
				await classifierRequest(
					"/classifiers/" + classifier.id + "/runs",
					"POST",
					{ mailbox_ids: targets, selection, reset, enable: false },
				);
				setStarted((ids) => [...ids, classifier.id]);
			}
		},
		onSuccess: done,
	});
	return (
		<Dialog.Root
			open
			onOpenChange={(open) => {
				if (!open && !run.isPending) close();
			}}
		>
			<Dialog
				style={{ zIndex: 110 }}
				className="max-h-[90dvh] overflow-y-auto p-6"
				size="sm"
			>
				<Dialog.Title className="text-base font-semibold">
					Run on existing conversations
				</Dialog.Title>
				<p className="text-sm text-kumo-subtle mt-2 mb-5">
					{classifiers.length === 1
						? classifiers[0].name
						: "All tags in this group"}{" "}
					· Active conversations only
				</p>
				<form
					className="space-y-5"
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						if (!run.isPending) run.mutate();
					}}
				>
					<fieldset
						disabled={run.isPending || started.length > 0}
						className="space-y-5"
					>
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
						<p className="text-xs text-kumo-subtle">
							{mode.data?.classifierPreview
								? "Preview runs use stored fixture answers."
								: "Runs continue after you close this page. Conversation text and metadata are sent to Typesafe.ai. Up to 5,000 conversations per run."}
						</p>
						{run.error && (
							<p role="alert" className="text-sm text-kumo-danger">
								{started.length > 0
									? `${started.length} tag runs started. Retry to start the remaining tags. `
									: ""}
								{run.error.message}
							</p>
						)}
					</fieldset>
					<div className="flex justify-end gap-2">
						<Button type="button" disabled={run.isPending} onClick={close}>
							Cancel
						</Button>
						<Button
							type="submit"
							variant="primary"
							disabled={!targets.length || run.isPending}
							loading={run.isPending}
						>
							Start run
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
