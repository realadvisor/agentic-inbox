import { DateRangeField } from "./DateRangeField";
import {
	Checkbox as KumoCheckbox,
	Textarea as KumoTextarea,
	Input as KumoInput,
} from "@cloudflare/kumo";
import { AppSelect } from "./AppSelect";
import { DecisionRules } from "./DecisionRules";
import type { DecisionRules as Rules } from "../../shared/decision-rules";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog } from "@cloudflare/kumo";
import { useMutation } from "@tanstack/react-query";
import { useTagMutation } from "~/queries/tags";
import { useMailboxes } from "~/queries/mailboxes";
import { useMailMode } from "./MailMode";
import { classifierRequest, type Classifier } from "~/services/classifiers";
const field = "w-full";
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
	decision_rules?: Partial<Rules>;
	enabled: boolean;
	question: string;
	mailbox_ids: string[];
	include_reviewed_examples: boolean;
};
export function automationDraft(c?: Classifier): AutomationDraft {
	return {
		enabled: c?.enabled ?? false,
		decision_rules: c?.decision_rules,
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
			<div className="flex items-center gap-2 text-sm font-medium">
				<KumoCheckbox
					disabled={disabled}
					checked={value.enabled}
					onCheckedChange={(e) => onChange({ ...value, enabled: e })}
					label={<>Assign automatically with Jev</>}
				/>
			</div>
			{value.enabled && (
				<>
					<label className="block text-sm font-medium">
						Instructions for Jev
						<KumoTextarea
							required
							maxLength={4000}
							rows={10}
							className={field + " mt-2 min-h-60 font-normal leading-relaxed"}
							value={value.question}
							onChange={(e) => onChange({ ...value, question: e.target.value })}
							placeholder="Should this conversation receive this tag? Describe when it applies."
						/>
					</label>
					<DecisionRules
						value={value.decision_rules}
						onChange={(decision_rules) =>
							onChange({ ...value, decision_rules })
						}
					/>
					<details>
						<summary className="cursor-pointer text-xs text-kumo-subtle">
							More options
						</summary>
						<div className="mt-3 space-y-3">
							<div className="block text-sm">
								Mailboxes
								<AppSelect
									disabled={disabled}
									label="Mailboxes"
									value={scope}
									options={[
										{ value: "all", label: "All mailboxes" },
										{ value: "selected", label: "Selected mailboxes" },
									]}
									onChange={(scope) => {
										setScope(scope);
										if (scope === "all")
											onChange({ ...value, mailbox_ids: [] });
									}}
								/>
							</div>
							{scope === "selected" && (
								<div className="space-y-2">
									{mailboxes.data?.map((m) => (
										<div key={m.id} className="flex items-center gap-2 text-sm">
											<KumoCheckbox
												disabled={disabled}
												checked={value.mailbox_ids.includes(m.id)}
												onCheckedChange={(e) =>
													onChange({
														...value,
														mailbox_ids: e
															? [...value.mailbox_ids, m.id]
															: value.mailbox_ids.filter((id) => id !== m.id),
													})
												}
												label={<>{m.name}</>}
											/>
										</div>
									))}
									{!value.mailbox_ids.length && (
										<p role="alert" className="text-xs text-kumo-danger">
											Choose a mailbox, or select All mailboxes.
										</p>
									)}
								</div>
							)}
							<div className="flex items-start gap-2 text-sm">
								<KumoCheckbox
									disabled={disabled}
									checked={value.include_reviewed_examples}
									onCheckedChange={(e) =>
										onChange({
											...value,
											include_reviewed_examples: e,
										})
									}
									label={<>Use recent human examples</>}
								/>
							</div>
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
	const mode = useMailMode();
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
					(!!mode.data?.classifierPreview &&
						classifiers.some((c) => !c.enabled))
				}
				onClick={() => setRunning(true)}
			>
				Reprocess conversations
			</Button>
			{active && (
				<p className="text-xs text-kumo-subtle">
					A run is already in progress. Wait for it to finish or cancel it
					below.
				</p>
			)}
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
					Uses the saved configuration. Automatic assignment stays off.
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
export function RunDialog({
	classifiers: availableClassifiers,
	chooseClassifiers = false,
	initialMailbox,
	groupNames = {},
	close,
	done,
}: {
	classifiers: Classifier[];
	chooseClassifiers?: boolean;
	initialMailbox?: string;
	groupNames?: Record<string, string>;
	close: () => void;
	done: (mailboxes: string[]) => void;
}) {
	const [chosen, setChosen] = useState(() =>
		availableClassifiers
			.filter(
				(c) =>
					!chooseClassifiers ||
					(c.enabled &&
						c.run?.status !== "running" &&
						(!initialMailbox ||
							!c.mailbox_ids.length ||
							c.mailbox_ids.includes(initialMailbox))),
			)
			.map((c) => c.id),
	);
	const classifiers = availableClassifiers.filter((c) => chosen.includes(c.id));
	const choices = Array.from(
		new Set(availableClassifiers.map((c) => c.group_id ?? c.id)),
	).map((id) => {
		const members = availableClassifiers.filter(
			(c) => (c.group_id ?? c.id) === id,
		);
		return {
			id,
			members,
			name: groupNames[id] ?? members.map((c) => c.name).join(" / "),
			running: members.some((c) => c.run?.status === "running"),
		};
	});
	const mailboxes = useMailboxes();
	const mode = useMailMode();
	const [selected, setSelected] = useState<string[] | null>(
		initialMailbox ? [initialMailbox] : null,
	);
	const [selection, setSelection] = useState(
		chooseClassifiers ? "all" : "unprocessed",
	);
	const [reset, setReset] = useState(false);
	const [from, setFrom] = useState("");
	const [to, setTo] = useState("");
	const [limit, setLimit] = useState("5000");

	const allowed = (mailboxes.data ?? []).filter((m) =>
		classifiers.every(
			(c) => !c.mailbox_ids.length || c.mailbox_ids.includes(m.id),
		),
	);
	const targets = (selected ?? allowed.map((m) => m.id)).filter((id) =>
		allowed.some((m) => m.id === id),
	);
	const [started, setStarted] = useState<string[]>([]);
	const validRange =
		(!from || !to || from <= to) &&
		Number.isInteger(Number(limit)) &&
		Number(limit) >= 1 &&
		Number(limit) <= 5000;
	const start = from ? new Date(from + "T00:00:00") : null;
	const end = to ? new Date(to + "T00:00:00") : null;
	if (end) end.setDate(end.getDate() + 1);
	const filters = {
		mailbox_ids: targets,
		selection,
		reset,
		enable: false,
		received_from: start?.toISOString(),
		received_before: end?.toISOString(),
		limit: Number(limit),
	};
	const preview = useQuery({
		queryKey: ["classifier-run-preview", classifiers.map((c) => c.id), filters],
		queryFn: () =>
			classifierRequest<{ count: number; counts: Record<string, number> }>(
				"/runs/preview",
				"POST",
				{
					...filters,
					classifier_ids: classifiers.map((c) => c.id),
				},
			),
		enabled:
			!mode.data?.classifierPreview &&
			targets.length > 0 &&
			classifiers.length > 0 &&
			validRange &&
			started.length === 0,
	});
	const run = useMutation({
		mutationFn: async () => {
			for (const classifier of classifiers) {
				if (
					started.includes(classifier.id) ||
					preview.data?.counts[classifier.id] === 0
				)
					continue;
				await classifierRequest(
					"/classifiers/" + classifier.id + "/runs",
					"POST",
					filters,
				);
				setStarted((ids) => [...ids, classifier.id]);
			}
		},
		onSuccess: () => done(targets),
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
					{chooseClassifiers
						? "Reprocess emails"
						: "Run on existing conversations"}
				</Dialog.Title>
				<p className="text-sm text-kumo-subtle mt-2 mb-5">
					{chooseClassifiers
						? "Choose tags and groups to reprocess"
						: classifiers.length === 1
							? classifiers[0].name
							: "All tags in this group"}{" "}
					· Active conversations only
				</p>
				<form
					className="space-y-5"
					onSubmit={(e) => {
						e.preventDefault();
						e.stopPropagation();
						if (
							!run.isPending &&
							validRange &&
							(mode.data?.classifierPreview ||
								started.length > 0 ||
								(!preview.isFetching && !!preview.data?.count))
						)
							run.mutate();
					}}
				>
					<fieldset
						disabled={run.isPending || started.length > 0}
						className="space-y-5"
					>
						{chooseClassifiers && (
							<fieldset className="space-y-2">
								<legend className="text-sm mb-2">Tags and groups</legend>
								{choices.map((choice) => (
									<div
										key={choice.id}
										className="flex items-center gap-2 text-sm"
									>
										<KumoCheckbox
											disabled={
												choice.running || run.isPending || started.length > 0
											}
											checked={choice.members.every((c) =>
												chosen.includes(c.id),
											)}
											onCheckedChange={(e) =>
												setChosen((ids) =>
													e
														? [
																...new Set([
																	...ids,
																	...choice.members.map((c) => c.id),
																]),
															]
														: ids.filter(
																(id) =>
																	!choice.members.some((c) => c.id === id),
															),
												)
											}
											label={
												<>
													{choice.name}
													{choice.running
														? " — already running"
														: !choice.members.some((c) => c.enabled)
															? " — manual"
															: ""}
												</>
											}
										/>
									</div>
								))}
							</fieldset>
						)}
						<div>
							<div className="text-sm mb-2">Mailboxes</div>
							<div className="flex flex-wrap gap-4">
								{allowed.map((m) => (
									<div key={m.id} className="flex gap-2 items-center text-sm">
										<KumoCheckbox
											disabled={run.isPending || started.length > 0}
											checked={targets.includes(m.id)}
											onCheckedChange={(e) =>
												setSelected(
													e
														? [...targets, m.id]
														: targets.filter((x) => x !== m.id),
												)
											}
											label={<>{m.name}</>}
										/>
									</div>
								))}
							</div>
						</div>
						<div className="block text-sm">
							Conversations
							<AppSelect
								disabled={run.isPending || started.length > 0}
								label="Conversations"
								value={selection}
								options={[
									{ value: "unprocessed", label: "Not yet processed" },
									{ value: "all", label: "All active conversations" },
								]}
								onChange={(value) => {
									setSelection(value);
									setReset(false);
								}}
							/>
						</div>
						{!mode.data?.classifierPreview && (
							<>
								<div>
									<span className="block text-sm mb-1.5">Received dates</span>
									<DateRangeField
										disabled={run.isPending || started.length > 0}
										from={from}
										to={to}
										onChange={(from, to) => {
											setFrom(from);
											setTo(to);
										}}
									/>
									<p className="text-xs text-kumo-subtle mt-2">
										Latest received email, in your local time. Leave dates empty
										for all time.
									</p>
								</div>
								<label className="block text-sm">
									Maximum conversations per classifier
									<KumoInput
										type="number"
										min={1}
										max={5000}
										step={1}
										className={field + " mt-1.5"}
										value={limit}
										onChange={(e) => setLimit(e.target.value)}
									/>
									<small className="block text-kumo-subtle mt-2">
										Newest matching conversations first. Up to 5,000.
									</small>
								</label>
								<div
									role="status"
									aria-live="polite"
									className="rounded-lg bg-kumo-control p-3 text-sm"
								>
									{!validRange
										? "Choose a valid date range and a count between 1 and 5,000."
										: !classifiers.length
											? "Select at least one tag or group."
											: !targets.length
												? "Select a mailbox to see the count."
												: preview.isFetching
													? "Counting conversations…"
													: preview.error
														? preview.error.message
														: `${preview.data?.count ?? 0} conversation${preview.data?.count === 1 ? "" : "s"} selected. Manual tags stay; reviewed answers stay unless reset below.`}
								</div>
							</>
						)}
						<div className="flex items-start gap-2 text-sm">
							<KumoCheckbox
								className="mt-1"
								checked={reset}
								disabled={
									selection !== "all" || run.isPending || started.length > 0
								}
								onCheckedChange={(e) => setReset(e)}
								label={
									<>
										<span>
											Reset manual classifier corrections
											<small className="block text-kumo-subtle">
												Ordinary manual tags stay. Choose all active to reset
												corrections.
											</small>
										</span>
									</>
								}
							/>
						</div>
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
							disabled={
								!classifiers.length ||
								!targets.length ||
								!validRange ||
								run.isPending ||
								(!mode.data?.classifierPreview &&
									started.length === 0 &&
									(preview.isFetching ||
										!!preview.error ||
										!preview.data?.count))
							}
							loading={run.isPending}
						>
							{chooseClassifiers ? "Start reprocessing" : "Start run"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
