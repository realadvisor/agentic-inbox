import { useQuery } from "@tanstack/react-query";
import AgentModelPicker from "./AgentModelPicker";
import "./agent-chat.css";
import "./composer-ai.css";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowUpIcon,
	SparkleIcon,
	LightningIcon,
	XIcon,
} from "@phosphor-icons/react";
import type { ComposerAiInput } from "shared/composer-ai";
import { escapeHtml, htmlToPlainText } from "~/lib/utils";
import api from "~/services/api";

export default function ComposerAiAssist({
	mailboxId,
	emailId,
	body,
	subject,
	recipients,
	onApply,
	onGeneratingChange,
	disabled = false,
	initialOpen = false,
	initialQuick = false,
}: {
	mailboxId: string;
	emailId?: string;
	body: string;
	subject: string;
	recipients: string;
	onApply: (html: string) => void;
	onGeneratingChange?: (generating: boolean) => void;
	disabled?: boolean;
	initialOpen?: boolean;
	initialQuick?: boolean;
}) {
	const toastManager = useKumoToastManager();
	const [model, setModel] = useState("");
	const [modelPortal, setModelPortal] = useState<HTMLDivElement | null>(null);
	const config = useQuery({
		queryKey: ["composer-ai-config", mailboxId],
		queryFn: () => api.getComposerAiConfig(mailboxId),
	});
	const models =
		config.data?.catalog.models.filter(
			(entry) =>
				entry.selectable &&
				(!config.data.catalog.gatewayConfigured || entry.source === "gateway"),
		) ?? [];
	const mailboxModel = config.data?.settings.model;
	const defaultModel =
		models.find((entry) => entry.id === mailboxModel)?.id ??
		models.find((entry) => entry.id === "openai/gpt-4.1-mini")?.id ??
		models[0]?.id ??
		"";
	const effectiveModel = model || defaultModel;
	const [open, setOpen] = useState(initialOpen);
	const [instructions, setInstructions] = useState("");
	const [loading, setLoading] = useState(false);
	useEffect(() => {
		onGeneratingChange?.(loading);
	}, [loading, onGeneratingChange]);
	const [error, setError] = useState("");
	const [suggestion, setSuggestion] = useState("");
	const [generated, setGenerated] = useState(false);
	const quickStarted = useRef(false);
	const controller = useRef<AbortController | null>(null);
	const latestBody = useRef(body);
	latestBody.current = body;
	useEffect(() => () => controller.current?.abort(), []);
	function apply(text: string, suffix = "") {
		onApply(
			text
				.split(/\n\s*\n/)
				.map((p) => `<p>${escapeHtml(p).replaceAll("\n", "<br>")}</p>`)
				.join("") + suffix,
		);
		setSuggestion("");
		setGenerated(true);
	}
	async function generate(
		action: ComposerAiInput["action"] = "draft",
		quick = false,
	) {
		controller.current?.abort();
		const current = new AbortController();
		controller.current = current;
		setLoading(true);
		setError("");
		if (quick) setOpen(false);
		const startBody = body;
		try {
			const result = await api.composeWithAi(
				mailboxId,
				{
					emailId,
					model: effectiveModel || undefined,
					action,
					instructions: quick
						? emailId
							? ""
							: `Write an email about: ${subject}`
						: instructions,
					body: quick
						? ""
						: action === "draft"
							? htmlToPlainText(body)
							: suggestion || htmlToPlainText(body),
					subject,
					recipients,
				},
				current.signal,
			);
			if (current.signal.aborted) return;
			if (quick) {
				apply(result.text, latestBody.current);
				return;
			}
			if (
				!htmlToPlainText(startBody).trim() &&
				latestBody.current === startBody &&
				!suggestion
			) {
				apply(result.text);
				setOpen(false);
			} else {
				setSuggestion(result.text);
				setOpen(true);
			}
		} catch (err) {
			if (!current.signal.aborted) {
				const message =
					err instanceof Error ? err.message : "Could not generate a draft.";
				if (quick) toastManager.add({ title: message, variant: "error" });
				else {
					setOpen(true);
					setError(message);
				}
			}
		} finally {
			if (controller.current === current) setLoading(false);
		}
	}
	useEffect(() => {
		if (!initialQuick || !effectiveModel || quickStarted.current) return;
		const timeout = window.setTimeout(() => {
			quickStarted.current = true;
			void generate("draft", true);
		}, 0);
		return () => window.clearTimeout(timeout);
	}, [initialQuick, effectiveModel]);
	const hasText = !!(suggestion || htmlToPlainText(body).trim());
	const canGenerate =
		!disabled &&
		!loading &&
		!!effectiveModel &&
		!!(emailId || instructions.trim());
	return (
		<div className="composer-ai-actions">
			<div
				className="ai-draft-button-group"
				role="group"
				aria-label="AI drafting"
			>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-label={loading ? "Stop AI generation" : "Quick Draft"}
					title={loading ? "Stop AI generation" : "Generate draft with AI"}
					disabled={
						disabled ||
						(!loading &&
							(!effectiveModel ||
								!(emailId || subject.trim() || htmlToPlainText(body).trim())))
					}
					onClick={() => {
						if (loading) {
							controller.current?.abort();
							setLoading(false);
						} else void generate("draft", true);
					}}
					icon={
						loading ? (
							<span className="composer-ai-spinner" />
						) : (
							<LightningIcon size={16} />
						)
					}
				>
					{loading ? "Stop" : "Quick Draft"}
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					aria-label="Advanced"
					title="Add instructions and choose a model"
					disabled={disabled}
					onClick={() => setOpen(true)}
					icon={<SparkleIcon size={16} />}
				>
					Advanced
				</Button>
			</div>
			<Dialog.Root open={open} onOpenChange={setOpen}>
				<Dialog size="sm" className="composer-ai-dialog overflow-visible p-0">
					<div className="composer-ai-heading">
						<Dialog.Title className="text-sm font-medium">
							Write with AI
						</Dialog.Title>
						<button
							type="button"
							className="composer-ai-close"
							aria-label="Close AI assistant"
							onClick={() => setOpen(false)}
						>
							<XIcon size={16} />
						</button>
					</div>

					<textarea
						aria-label="AI instructions"
						value={instructions}
						rows={4}
						autoFocus
						maxLength={2000}
						onChange={(e) => setInstructions(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								e.stopPropagation();
								if (canGenerate) void generate();
							}
						}}
						placeholder={
							emailId
								? "What would you like to say?"
								: "Describe the email you want to write…"
						}
					/>
					<div className="composer-ai-toolbar">
						<div className="composer-ai-model" ref={setModelPortal}>
							{config.data && (
								<AgentModelPicker
									models={models}
									value={model}
									defaultModel={defaultModel}
									disabled={loading || disabled}
									onChange={setModel}
									context="draft"
									portalContainer={modelPortal}
								/>
							)}
						</div>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							icon={<LightningIcon size={14} />}
							disabled={
								disabled ||
								loading ||
								!effectiveModel ||
								!(emailId || subject.trim() || htmlToPlainText(body).trim())
							}
							onClick={() => void generate("draft", true)}
						>
							Quick Draft
						</Button>
						{loading ? (
							<button
								type="button"
								className="composer-ai-generate"
								aria-label="Drafting…"
								onClick={() => {
									controller.current?.abort();
									setLoading(false);
								}}
							>
								<span className="composer-ai-spinner" /> Stop
							</button>
						) : (
							<button
								type="button"
								className="composer-ai-generate"
								disabled={!canGenerate}
								aria-label={generated || suggestion ? "Try again" : "Generate"}
								onClick={() => void generate()}
							>
								{generated || suggestion
									? "Try again"
									: emailId
										? "Draft reply"
										: "Generate"}
								<ArrowUpIcon size={14} weight="bold" />
							</button>
						)}
					</div>
					{hasText && (
						<div className="composer-ai-refinements">
							<span>Refine</span>
							{(
								[
									["improve", "Improve"],
									["shorten", "Shorten"],
									["formalize", "Formal"],
								] as const
							).map(([action, label]) => (
								<button
									key={action}
									type="button"
									disabled={disabled || loading}
									onClick={() => void generate(action)}
								>
									{label}
								</button>
							))}
						</div>
					)}
					{config.isError && (
						<p role="alert" className="composer-ai-error">
							Could not load models.{" "}
							<button type="button" onClick={() => void config.refetch()}>
								Retry
							</button>
						</p>
					)}
					{error && (
						<p role="alert" className="composer-ai-error">
							{error}
						</p>
					)}
					{suggestion && (
						<div className="composer-ai-suggestion">
							<p className="composer-ai-suggestion-label">
								<SparkleIcon size={13} /> Suggested draft
							</p>
							<div
								className="composer-ai-suggestion-body"
								aria-label="AI suggestion"
							>
								{suggestion}
							</div>
							<div className="composer-ai-suggestion-actions">
								<Button
									type="button"
									size="sm"
									variant="secondary"
									disabled={disabled || loading}
									onClick={() => {
										apply(suggestion);
										setOpen(false);
									}}
								>
									Use suggestion
								</Button>
								<Button
									type="button"
									size="sm"
									variant="ghost"
									disabled={loading}
									onClick={() => setSuggestion("")}
								>
									Keep mine
								</Button>
							</div>
						</div>
					)}
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
