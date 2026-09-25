import ComposerAiAssist from "./ComposerAiAssist";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo";
import {
	ArrowsOutSimpleIcon,
	ArrowsInSimpleIcon,
	XIcon,
	PaperPlaneTiltIcon,
	FloppyDiskIcon,
	TextAaIcon,
	TrashIcon,
	ArrowBendUpLeftIcon,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import { useUIStore } from "~/hooks/useUIStore";
import { useMailbox } from "~/queries/mailboxes";
import { SendLabel } from "~/components/MailMode";
import RichTextEditor from "./RichTextEditor";
import RecipientField from "./RecipientField";

export default function ComposePanel({ inline = false }: { inline?: boolean }) {
	const { mailboxId, folder } = useParams();
	const { data: mailbox } = useMailbox(mailboxId);
	const { composeOptions } = useUIStore();
	const form = useComposeForm(mailboxId, folder, true);
	const [expanded, setExpanded] = useState(false);
	const [formatting, setFormatting] = useState(false);
	const panel = useRef<HTMLElement>(null);
	const formRef = useRef<HTMLFormElement>(null);
	useLayoutEffect(() => {
		if (inline && !expanded)
			panel.current?.scrollIntoView({
				block: "start",
				inline: "nearest",
				behavior: "instant",
			});
	}, [inline, expanded]);
	const busy = form.isSending || form.isSavingDraft;
	return (
		<section
			ref={panel}
			aria-label="Email composer"
			className={
				expanded
					? "fixed inset-3 md:inset-10 z-50 flex flex-col rounded-xl border border-kumo-line bg-kumo-base shadow-2xl"
					: "flex flex-col min-h-0 bg-kumo-base " +
						(inline
							? "m-3 md:m-5 rounded-xl border border-kumo-line shadow-sm"
							: "h-full")
			}
		>
			<header className="flex items-center justify-between px-4 py-2 border-b border-kumo-line/60">
				<div className="flex items-center gap-2 text-sm font-medium">
					<ArrowBendUpLeftIcon size={17} className="text-kumo-subtle" />
					{form.formTitle}
				</div>
				<div className="flex items-center gap-1">
					{mailboxId && (
						<ComposerAiAssist
							mailboxId={mailboxId}
							emailId={
								composeOptions.originalEmail?.id ??
								composeOptions.draftEmail?.in_reply_to ??
								undefined
							}
							body={form.body}
							subject={form.subject}
							recipients={form.to}
							onApply={form.setBody}
							disabled={busy}
							initialOpen={composeOptions.aiDraft}
							initialQuick={composeOptions.quickDraft}
						/>
					)}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						shape="square"
						aria-label={expanded ? "Collapse composer" : "Expand composer"}
						onClick={() => setExpanded(!expanded)}
						icon={
							expanded ? (
								<ArrowsInSimpleIcon size={16} />
							) : (
								<ArrowsOutSimpleIcon size={16} />
							)
						}
					/>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						shape="square"
						aria-label="Close compose"
						disabled={busy}
						onClick={form.closeCompose}
						icon={<XIcon size={16} />}
					/>
				</div>
			</header>
			<form
				ref={formRef}
				onSubmit={(event) => form.handleSend(event, form.closeCompose)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						if (event.target instanceof HTMLElement) event.target.blur();
						requestAnimationFrame(() => formRef.current?.requestSubmit());
					}
				}}
				className="flex flex-col flex-1 min-h-0"
			>
				<div className="flex-1 min-h-0 overflow-y-auto">
					<div>
						<div className="flex items-center gap-2 px-4 py-2 border-b border-kumo-line/60 text-xs">
							<span className="w-10 shrink-0 text-kumo-subtle">From</span>
							<span className="min-w-0 truncate text-kumo-subtle">
								{mailbox?.name}{" "}
								<span className="text-kumo-inactive">
									&lt;{mailbox?.email}&gt;
								</span>
							</span>
						</div>
						<RecipientField
							label="To"
							value={form.to}
							onChange={form.setTo}
							action={
								!form.showCcBcc ? (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() => form.setShowCcBcc(true)}
										className="!h-6 !px-2 !text-xs text-kumo-subtle"
									>
										Cc / Bcc
									</Button>
								) : undefined
							}
						/>

						{form.showCcBcc && (
							<>
								<RecipientField
									label="Cc"
									value={form.cc}
									onChange={form.setCc}
								/>
								<RecipientField
									label="Bcc"
									value={form.bcc}
									onChange={form.setBcc}
								/>
							</>
						)}
						{!inline || composeOptions.mode === "forward" ? (
							<div className="flex items-center gap-2 px-4 border-b border-kumo-line/60 py-2">
								<label
									htmlFor="compose-subject"
									className="w-10 text-xs text-kumo-subtle"
								>
									Subject
								</label>
								<input
									id="compose-subject"
									aria-label="Subject"
									required
									value={form.subject}
									onChange={(e) => form.setSubject(e.target.value)}
									placeholder="Add a subject"
									className="flex-1 min-w-0 bg-transparent text-sm outline-none"
								/>
							</div>
						) : null}
					</div>

					<div className="px-2 pt-3">
						<RichTextEditor
							value={form.body}
							onChange={form.setBody}
							minimal
							showToolbar={formatting}
						/>
					</div>
					{form.quotedBody && (
						<details className="mx-5 mb-4 text-xs text-kumo-subtle">
							<summary className="cursor-pointer py-2">
								Show quoted message
							</summary>
							<div className="max-h-40 overflow-auto border-l-2 border-kumo-line pl-3 whitespace-pre-wrap">
								{form.quotedText}
							</div>
						</details>
					)}
				</div>
				{form.error && (
					<p role="alert" className="px-5 py-2 text-sm text-kumo-destructive">
						{form.error}
					</p>
				)}
				<footer className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line/60 px-4 py-2.5">
					<div className="flex items-center gap-2">
						<Button
							type="submit"
							size="sm"
							variant="primary"
							disabled={busy}
							icon={<PaperPlaneTiltIcon size={16} />}
						>
							<SendLabel sending={form.isSending} />
						</Button>
						<span className="hidden lg:inline text-xs text-kumo-inactive">
							⌘ Enter
						</span>
					</div>
					<div className="flex items-center gap-1">
						<Button
							type="button"
							size="sm"
							variant={formatting ? "secondary" : "ghost"}
							shape="square"
							aria-label="Formatting"
							aria-pressed={formatting}
							onClick={() => setFormatting(!formatting)}
							icon={<TextAaIcon size={18} />}
						/>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							icon={<FloppyDiskIcon size={14} />}
							disabled={busy}
							onClick={form.handleSaveDraft}
						>
							{form.isSavingDraft ? "Saving…" : "Save as Draft"}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							shape="square"
							disabled={busy}
							aria-label="Discard draft"
							onClick={form.closeCompose}
							icon={<TrashIcon size={16} />}
						/>
					</div>
				</footer>
			</form>
		</section>
	);
}
