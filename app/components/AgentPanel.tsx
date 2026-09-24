import { useEffect, useMemo, useRef, useState } from "react";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Input } from "@cloudflare/kumo";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
	ArrowUpIcon,
	PlusIcon,
	ClockCounterClockwiseIcon,
	StopIcon,
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
import type {
	AgentConversation,
	AgentTurn,
	AgentState,
	InboxChatMessage,
} from "../../shared/agent";
import { turnsToMessages } from "../../shared/agent-messages";
const endpoint = (mailbox: string) =>
	`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/agent`;
async function getState(
	mailbox: string,
	conversationId?: string,
	before?: string,
): Promise<AgentState> {
	const params = new URLSearchParams();
	if (conversationId) params.set("conversationId", conversationId);
	if (before) params.set("before", before);
	const response = await fetch(`${endpoint(mailbox)}?${params}`);
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
	const [conversationId, setConversationId] = useState<string | undefined>(
		() => {
			try {
				return (
					localStorage.getItem(`agent-conversation:${mailboxId}`) ?? undefined
				);
			} catch {
				return undefined;
			}
		},
	);
	const [historyOpen, setHistoryOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [creating, setCreating] = useState(false);
	const [navigationError, setNavigationError] = useState("");
	const selectConversation = (id: string) => {
		setConversationId(id);
		try {
			localStorage.setItem(`agent-conversation:${mailboxId}`, id);
		} catch {
			/* Storage may be disabled. */
		}
		setHistoryOpen(false);
	};
	const newConversation = async () => {
		setCreating(true);
		setNavigationError("");
		try {
			const response = await fetch(`${endpoint(mailboxId)}/conversations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			if (!response.ok)
				throw new Error("Could not create a conversation. Try again.");
			const conversation: AgentConversation = await response.json();
			selectConversation(conversation.id);
		} catch (error) {
			setNavigationError(
				error instanceof Error
					? error.message
					: "Could not create conversation",
			);
		} finally {
			setCreating(false);
		}
	};
	const state = useQuery({
		queryKey: ["agent", mailboxId, conversationId],
		queryFn: () => getState(mailboxId, conversationId),
		refetchInterval: (query) =>
			query.state.data?.turns.some((t) => t.status === "running")
				? 2000
				: 10000,
	});
	useEffect(() => {
		if (!conversationId && state.data?.conversation.id) {
			setConversationId(state.data.conversation.id);
			try {
				localStorage.setItem(
					`agent-conversation:${mailboxId}`,
					state.data.conversation.id,
				);
			} catch {
				/* Optional persistence. */
			}
		}
	}, [conversationId, mailboxId, state.data?.conversation.id]);
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
					<button
						className="agent-icon-button"
						aria-label="New conversation"
						title="New conversation"
						disabled={busy || creating}
						onClick={() => void newConversation()}
					>
						<PlusIcon size={17} />
					</button>
					<button
						className="agent-icon-button"
						aria-label="Conversation history"
						title="Conversation history"
						aria-expanded={historyOpen}
						onClick={() => setHistoryOpen(!historyOpen)}
					>
						<ClockCounterClockwiseIcon size={17} />
					</button>
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
			{navigationError && (
				<p role="alert" className="agent-error">
					{navigationError}
				</p>
			)}
			{historyOpen && (
				<ConversationHistory
					mailboxId={mailboxId}
					activeId={state.data?.conversation.id}
					disabled={busy || creating}
					onSelect={selectConversation}
					onBack={() => setHistoryOpen(false)}
				/>
			)}
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
				<div
					className="agent-chat-body"
					style={{ display: historyOpen ? "none" : undefined }}
				>
					<AgentChat
						key={`${mailboxId}:${state.data.conversation.id}`}
						mailboxId={mailboxId}
						state={state.data}
						onBusy={setBusy}
					/>
				</div>
			)}
		</aside>
	);
}
function ConversationHistory({
	mailboxId,
	activeId,
	disabled,
	onSelect,
	onBack,
}: {
	mailboxId: string;
	activeId?: string;
	disabled: boolean;
	onSelect: (id: string) => void;
	onBack: () => void;
}) {
	const [search, setSearch] = useState("");
	const history = useInfiniteQuery({
		queryKey: ["agent-history", mailboxId, search],
		initialPageParam: 0,
		queryFn: async ({ pageParam, signal }) => {
			const response = await fetch(
				`${endpoint(mailboxId)}/conversations?${new URLSearchParams({ search, offset: String(pageParam) })}`,
				{ signal },
			);
			if (!response.ok) throw new Error("Could not load conversation history");
			return (await response.json()) as {
				conversations: AgentConversation[];
				hasMore: boolean;
			};
		},
		getNextPageParam: (lastPage, pages) =>
			lastPage.hasMore ? pages.length * 50 : undefined,
	});
	const conversations = [
		...new Map(
			history.data?.pages
				.flatMap((page) => page.conversations)
				.map((c) => [c.id, c]),
		).values(),
	];
	return (
		<section className="agent-history" aria-label="Conversation history">
			<div className="agent-history-heading">
				<h3>Conversations</h3>
				<button
					className="agent-icon-button"
					aria-label="Back to conversation"
					onClick={onBack}
				>
					<XIcon size={17} />
				</button>
			</div>
			<div className="agent-history-search">
				<Input
					aria-label="Search conversations"
					placeholder="Search conversations…"
					value={search}
					onChange={(e) => {
						setSearch(e.target.value);
					}}
				/>
			</div>
			{disabled && (
				<p className="agent-history-note">
					Finish or stop the current response before switching chats.
				</p>
			)}
			{history.isLoading && <p>Loading conversations…</p>}
			{history.error && (
				<p role="alert">
					{history.error.message}{" "}
					<button onClick={() => void history.refetch()}>Retry</button>
				</p>
			)}
			{history.data && conversations.length === 0 && (
				<p>No conversations found.</p>
			)}
			<div className="agent-history-list">
				{conversations.map((conversation) => (
					<button
						key={conversation.id}
						disabled={disabled}
						aria-current={conversation.id === activeId ? "true" : undefined}
						onClick={() => onSelect(conversation.id)}
					>
						<strong title={conversation.title}>{conversation.title}</strong>
						<span>
							{new Date(conversation.updated_at).toLocaleDateString(undefined, {
								month: "short",
								day: "numeric",
								year: "numeric",
							})}
						</span>
					</button>
				))}
			</div>
			{history.hasNextPage && (
				<button
					className="agent-history-more"
					disabled={history.isFetchingNextPage}
					onClick={() => void history.fetchNextPage()}
				>
					Load more conversations
				</button>
			)}
		</section>
	);
}
function AgentChat({
	mailboxId,
	state,
	onBusy,
}: {
	mailboxId: string;
	state: AgentState;
	onBusy: (busy: boolean) => void;
}) {
	const client = useQueryClient();
	const { selectedEmailId, openComposeModal, agentModels, setAgentModel } =
		useUIStore();
	const modelKey = `${mailboxId}:${state.conversation.id}`;
	const selectedModel =
		agentModels[modelKey] ?? state.turns.at(-1)?.model ?? "";
	const effectiveModel = selectedModel || state.settings.model;
	const models = state.catalog.models;
	const modelAvailable = models.some(
		(m) => m.id === effectiveModel && m.selectable,
	);
	const [olderTurns, setOlderTurns] = useState<AgentTurn[]>([]);
	const [moreOlder, setMoreOlder] = useState<boolean | undefined>();
	const [loadingOlder, setLoadingOlder] = useState(false);
	const allTurns = useMemo(
		() => [
			...olderTurns.filter(
				(t) => !state.turns.some((recent) => recent.id === t.id),
			),
			...state.turns,
		],
		[olderTurns, state.turns],
	);
	const loadOlder = async () => {
		setLoadingOlder(true);
		try {
			const page = await getState(
				mailboxId,
				state.conversation.id,
				allTurns[0]?.id,
			);
			follow.current = false;
			setOlderTurns([...page.turns, ...allTurns]);
			setMoreOlder(page.hasMore);
		} catch {
			setDraftError("Could not load earlier messages. Try again.");
		} finally {
			setLoadingOlder(false);
		}
	};
	const [prompt, setPrompt] = useState("");
	const [draftError, setDraftError] = useState("");
	const [stopping, setStopping] = useState(false);
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
	const {
		messages,
		sendMessage,
		status,
		error,
		setMessages,
		clearError,
		stop,
	} = useChat<InboxChatMessage>({
		id: `${mailboxId}:${state.conversation.id}`,
		transport,
		generateId: () => crypto.randomUUID(),
		messages: turnsToMessages(allTurns),
		onFinish: refresh,
		onError: () => {
			void refresh();
		},
	});
	const busy = status === "submitted" || status === "streaming";
	const running = busy || state.turns.some((t) => t.status === "running");
	useEffect(() => {
		onBusy(running);
		return () => onBusy(false);
	}, [running, onBusy]);
	useEffect(() => {
		if (!busy) setMessages(turnsToMessages(allTurns));
	}, [allTurns, busy, error, setMessages]);
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
					conversationId: state.conversation.id,
					model: effectiveModel,
					...(selectedEmailId ? { emailId: selectedEmailId } : {}),
				},
			},
		);
	};
	const stopActive = async () => {
		const id =
			state.turns.find((t) => t.status === "running")?.id ??
			[...messages].reverse().find((m) => m.role === "user")?.id;
		if (!id) return;
		setStopping(true);
		setDraftError("");
		try {
			const response = await fetch(`${endpoint(mailboxId)}/stop`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id }),
			});
			if (!response.ok)
				throw new Error(
					"Could not confirm the stop. The assistant may still be running; try Stop again.",
				);
			await stop();
			clearError();
			await refresh();
		} catch (err) {
			setDraftError(
				err instanceof Error ? err.message : "Could not stop the assistant",
			);
		} finally {
			setStopping(false);
		}
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
				{(moreOlder ?? state.hasMore) && (
					<button
						className="agent-history-more"
						disabled={loadingOlder || running}
						onClick={() => void loadOlder()}
					>
						{loadingOlder ? "Loading…" : "Load earlier messages"}
					</button>
				)}
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
							{state.conversation.title}
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
							onChange={(value) => setAgentModel(modelKey, value)}
						/>
						{running ? (
							<button
								type="button"
								className="agent-send"
								aria-label="Stop assistant"
								title="Stop assistant"
								disabled={stopping}
								onClick={() => void stopActive()}
							>
								<StopIcon size={15} weight="fill" />
							</button>
						) : (
							<button
								type="submit"
								className="agent-send"
								aria-label="Send message"
								title="Send message"
								disabled={!prompt.trim() || running || !modelAvailable}
							>
								<ArrowUpIcon size={17} weight="bold" />
							</button>
						)}
					</div>
				</div>
			</form>
		</>
	);
}
