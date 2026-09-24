import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
	ArrowUpIcon,
	ArrowUpRightIcon,
	ArrowsOutSimpleIcon,
	ArrowsInSimpleIcon,
	EnvelopeSimpleIcon,
	GearSixIcon,
	MagnifyingGlassIcon,
	SparkleIcon,
	TextAlignLeftIcon,
	XIcon,
} from "@phosphor-icons/react";
import AgentMessage from "./AgentMessage";
import AgentModelPicker from "./AgentModelPicker";
import "./agent-chat.css";
import { Link } from "react-router";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import type { AgentState, InboxChatMessage } from "../../shared/agent";
import { turnsToMessages } from "../../shared/agent-messages";
const endpoint = (mailbox: string) =>
	`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/agent`;
async function getState(mailbox: string): Promise<AgentState> {
	const response = await fetch(endpoint(mailbox));
	if (!response.ok) throw new Error("Could not load the inbox assistant");
	return response.json();
}
export default function AgentPanel({
	mailboxId,
	close,
}: {
	mailboxId: string;
	close: () => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const state = useQuery({
		queryKey: ["agent", mailboxId],
		queryFn: () => getState(mailboxId),
		refetchInterval: 10000,
	});
	return (
		<aside
			aria-label="Email agent"
			className="inbox-assistant"
			data-expanded={expanded}
		>
			<header className="agent-header">
				<div className="agent-header-title">
					<span className="agent-mark">
						<SparkleIcon size={17} weight="fill" />
					</span>
					<h2>Assistant</h2>
					<span className="agent-header-badge">Inbox</span>
				</div>
				<div className="agent-header-actions">
					<Link
						className="agent-icon-button"
						aria-label="Assistant settings"
						title="Assistant settings"
						to={`/mailbox/${encodeURIComponent(mailboxId)}/settings?tab=models`}
						onClick={close}
					>
						<GearSixIcon size={17} />
					</Link>
					<button
						className="agent-icon-button agent-expand"
						type="button"
						aria-label={expanded ? "Collapse assistant" : "Expand assistant"}
						title={expanded ? "Collapse" : "Expand"}
						onClick={() => setExpanded(!expanded)}
					>
						{expanded ? (
							<ArrowsInSimpleIcon size={16} />
						) : (
							<ArrowsOutSimpleIcon size={16} />
						)}
					</button>
					<button
						className="agent-icon-button"
						type="button"
						onClick={close}
						aria-label="Close email agent"
						title="Close"
					>
						<XIcon size={17} />
					</button>
				</div>
			</header>
			{state.isLoading && (
				<p className="p-4 text-sm text-kumo-subtle">Loading conversation…</p>
			)}
			{state.error && (
				<p role="alert" className="p-4 text-sm">
					{state.error.message}{" "}
					<button className="underline" onClick={() => void state.refetch()}>
						Retry
					</button>
				</p>
			)}
			{state.data && (
				<AgentChat key={mailboxId} mailboxId={mailboxId} state={state.data} />
			)}
		</aside>
	);
}
function AgentChat({
	mailboxId,
	state,
}: {
	mailboxId: string;
	state: AgentState;
}) {
	const client = useQueryClient();
	const { selectedEmailId, openComposeModal, agentModels, setAgentModel } =
		useUIStore();
	const selectedModel = agentModels[mailboxId] ?? "";
	const effectiveModel = selectedModel || state.settings.model;
	const models = state.catalog.models;
	const modelAvailable = models.some(
		(m) => m.id === effectiveModel && m.selectable,
	);
	const [prompt, setPrompt] = useState("");
	const [draftError, setDraftError] = useState("");
	const bottom = useRef<HTMLDivElement>(null);
	const scrollArea = useRef<HTMLDivElement>(null);
	const follow = useRef(true);
	const refresh = async () => {
		await Promise.all([
			client.invalidateQueries({ queryKey: ["agent", mailboxId] }),
			client.invalidateQueries({ queryKey: ["emails", mailboxId] }),
			client.invalidateQueries({ queryKey: ["folders", mailboxId] }),
			client.invalidateQueries({ queryKey: ["search", mailboxId] }),
		]);
	};
	const transport = useMemo(
		() =>
			new DefaultChatTransport<InboxChatMessage>({
				api: `${endpoint(mailboxId)}/chat`,
				prepareSendMessagesRequest: ({ messages, body }) => {
					const message = messages[messages.length - 1];
					return {
						body: {
							...body,
							id: message.id,
							prompt: message.parts
								.filter((p) => p.type === "text")
								.map((p) => p.text)
								.join("\n"),
						},
					};
				},
			}),
		[mailboxId],
	);
	const { messages, sendMessage, status, error, setMessages, clearError } =
		useChat<InboxChatMessage>({
			id: mailboxId,
			transport,
			generateId: () => crypto.randomUUID(),
			messages: turnsToMessages(state.turns),
			onFinish: refresh,
			onError: () => {
				void refresh();
			},
		});
	const busy = status === "submitted" || status === "streaming";
	const running = busy || state.turns.some((t) => t.status === "running");
	useEffect(() => {
		if (!busy && !error) setMessages(turnsToMessages(state.turns));
	}, [state.turns, busy, error, setMessages]);
	useEffect(() => {
		if (follow.current) bottom.current?.scrollIntoView({ block: "nearest" });
	}, [messages, status]);
	const send = async (text: string) => {
		if (running || !text.trim() || !modelAvailable) return;
		clearError();
		setDraftError("");
		setPrompt("");
		follow.current = true;
		await sendMessage(
			{ text },
			{
				body: {
					model: effectiveModel,
					...(selectedEmailId ? { emailId: selectedEmailId } : {}),
				},
			},
		);
	};
	const openDraft = async (id: string) => {
		try {
			const email = await api.getEmail(mailboxId, id);
			if (email.delivery_status !== "draft")
				throw new Error("This draft has already been sent or removed");
			openComposeModal({ mode: "new", draftEmail: email });
		} catch (err) {
			setDraftError(
				err instanceof Error ? err.message : "Could not open draft",
			);
		}
	};
	return (
		<>
			<div
				ref={scrollArea}
				onScroll={() => {
					const el = scrollArea.current;
					if (el)
						follow.current =
							el.scrollHeight - el.scrollTop - el.clientHeight < 100;
				}}
				className="agent-conversation"
				aria-live="polite"
			>
				{!messages.length ? (
					<div className="agent-welcome">
						<div className="agent-welcome-mark">
							<SparkleIcon size={28} weight="duotone" />
						</div>
						<p className="agent-eyebrow">A LITTLE LESS INBOX.</p>
						<h3>
							Make room for
							<br />
							what matters.
						</h3>
						<p className="agent-welcome-description">
							Catch up on conversations, find what you need,
							<br className="agent-desktop-break" /> and turn your next reply
							into a first draft.
						</p>
						<div className="agent-suggestions">
							{[
								{
									label: "Catch me up",
									detail: "A quick summary of your inbox",
									prompt: "Summarize my inbox",
									Icon: TextAlignLeftIcon,
								},
								{
									label: "Find a conversation",
									detail: "Search your emails in plain English",
									prompt:
										"Help me find a conversation. Ask me what I am looking for.",
									Icon: MagnifyingGlassIcon,
								},
								{
									label: "What needs a reply?",
									detail: "Find the messages worth your attention",
									prompt: "Find emails needing a reply",
									Icon: EnvelopeSimpleIcon,
								},
							].map(({ label, detail, prompt, Icon }) => (
								<button
									type="button"
									key={label}
									disabled={!modelAvailable || running}
									onClick={() => void send(prompt)}
								>
									<span className="agent-suggestion-icon">
										<Icon size={18} />
									</span>
									<span>
										<strong>{label}</strong>
										<small>{detail}</small>
									</span>
									<ArrowUpRightIcon size={15} />
								</button>
							))}
						</div>
					</div>
				) : (
					<div className="agent-transcript">
						<div className="agent-conversation-label">
							<span />
							Your inbox, in focus
							<span />
						</div>
						{messages.map((message) => (
							<AgentMessage
								key={message.id}
								message={message}
								modelName={
									models.find((m) => m.id === message.metadata?.model)?.name ??
									message.metadata?.model ??
									"Assistant"
								}
								onReview={(id) => void openDraft(id)}
							/>
						))}
					</div>
				)}
				{(busy || running) && (
					<div className="agent-working" role="status">
						<span className="agent-working-dots">
							<i />
							<i />
							<i />
						</span>
						<span>
							{status === "submitted"
								? "Thinking"
								: "Working through your inbox"}
						</span>
					</div>
				)}
				<div ref={bottom} />
			</div>
			<form
				className="agent-compose-area"
				onSubmit={(event) => {
					event.preventDefault();
					void send(prompt);
				}}
			>
				{(error || draftError) && (
					<p role="alert" className="agent-error">
						{draftError || error?.message}
					</p>
				)}
				{!modelAvailable && (
					<p role="alert" className="agent-error">
						Choose an available model, or connect its provider in Settings.
					</p>
				)}
				<div className="agent-composer">
					{selectedEmailId && (
						<div className="agent-context">
							<EnvelopeSimpleIcon size={13} />
							<span>Selected conversation</span>
							<button
								type="button"
								disabled={running || !modelAvailable}
								onClick={() =>
									void send(
										"Read the selected email and its conversation, then save a draft reply for my review.",
									)
								}
							>
								Draft reply
								<ArrowUpRightIcon size={12} />
							</button>
						</div>
					)}
					<textarea
						aria-label="Message email agent"
						rows={3}
						maxLength={8000}
						placeholder="Ask anything about your inbox…"
						value={prompt}
						disabled={running || !modelAvailable}
						onChange={(event) => setPrompt(event.target.value)}
						onKeyDown={(event) => {
							if (
								event.key === "Enter" &&
								!event.shiftKey &&
								!event.nativeEvent.isComposing
							) {
								event.preventDefault();
								void send(prompt);
							}
						}}
					/>
					<div className="agent-composer-toolbar">
						<AgentModelPicker
							models={models}
							value={selectedModel}
							defaultModel={state.settings.model}
							disabled={running}
							onChange={(value) => setAgentModel(mailboxId, value)}
						/>
						<button
							type="submit"
							className="agent-send"
							aria-label="Send message"
							title="Send message"
							disabled={!prompt.trim() || running || !modelAvailable}
						>
							<ArrowUpIcon size={17} weight="bold" />
						</button>
					</div>
				</div>
			</form>
		</>
	);
}
