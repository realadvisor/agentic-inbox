import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	getToolOrDynamicToolName,
	isToolOrDynamicToolUIPart,
} from "ai";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link } from "react-router";
import { Button } from "@cloudflare/kumo";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import type { AgentState, InboxChatMessage } from "../../shared/agent";
import {
	draftIdFromOutput,
	turnsToMessages,
} from "../../shared/agent-messages";

const endpoint = (mailbox: string) =>
	`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/agent`;
const toolLabels: Record<string, string> = {
	list_emails: "Read inbox",
	get_email: "Read email",
	get_thread: "Read conversation",
	search_emails: "Search emails",
	draft_reply: "Draft reply",
	draft_email: "Compose draft",
	mark_email_read: "Update read status",
	move_email: "Move email",
	discard_draft: "Discard draft",
};
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
	const state = useQuery({
		queryKey: ["agent", mailboxId],
		queryFn: () => getState(mailboxId),
		refetchInterval: 10000,
	});
	return (
		<aside
			aria-label="Email agent"
			className="fixed inset-0 z-40 flex flex-col border-l border-kumo-line bg-kumo-base text-kumo-default md:static md:z-0 md:w-[460px] md:shrink-0"
		>
			<header className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
				<h2 className="text-sm font-semibold">Inbox assistant</h2>
				<div className="flex items-center gap-3">
					<Link
						className="text-xs text-kumo-subtle hover:underline"
						to={`/mailbox/${encodeURIComponent(mailboxId)}/settings?tab=models`}
						onClick={close}
					>
						Settings
					</Link>
					<Button
						variant="ghost"
						size="sm"
						onClick={close}
						aria-label="Close email agent"
					>
						Close
					</Button>
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
				className="min-h-0 flex-1 overflow-y-auto p-4"
				aria-live="polite"
			>
				{!messages.length && (
					<div className="flex min-h-64 flex-col justify-center gap-4 py-8">
						<div>
							<h3 className="text-lg font-medium">
								How can I help with your inbox?
							</h3>
							<p className="mt-2 text-sm text-kumo-subtle">
								Find a conversation, summarize your mail, or prepare a reply.
							</p>
						</div>
						<div className="flex flex-wrap gap-2">
							{["Summarize my inbox", "Find emails needing a reply"].map(
								(text) => (
									<Button
										key={text}
										variant="secondary"
										size="sm"
										disabled={!modelAvailable || running}
										onClick={() => void send(text)}
									>
										{text}
									</Button>
								),
							)}
						</div>
					</div>
				)}
				{messages.map((message) => (
					<article
						key={message.id}
						className={`mb-6 text-sm ${message.role === "user" ? "ml-8 rounded-xl bg-kumo-tint px-4 py-3" : "space-y-3"}`}
					>
						{message.role === "assistant" && (
							<p className="text-xs font-medium text-kumo-subtle">
								{models.find((m) => m.id === message.metadata?.model)?.name ??
									message.metadata?.model ??
									"Assistant"}
							</p>
						)}
						{message.parts.map((part, index) => {
							if (part.type === "text")
								return message.role === "user" ? (
									<p key={index} className="whitespace-pre-wrap break-words">
										{part.text}
									</p>
								) : (
									<div
										key={index}
										className="break-words leading-relaxed [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-kumo-tint [&_pre]:p-3 [&_code]:text-xs [&_a]:text-kumo-link [&_a]:underline [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:border-kumo-line [&_td]:p-2 [&_th]:border [&_th]:border-kumo-line [&_th]:p-2"
									>
										<Markdown
											remarkPlugins={[remarkGfm]}
											components={{
												a: ({ children, ...props }) => (
													<a
														{...props}
														target="_blank"
														rel="noopener noreferrer"
													>
														{children}
													</a>
												),
											}}
										>
											{part.text}
										</Markdown>
									</div>
								);
							if (!isToolOrDynamicToolUIPart(part)) return null;
							const name = getToolOrDynamicToolName(part);
							const failed = part.state === "output-error";
							const done = part.state === "output-available";
							const draft = done ? draftIdFromOutput(part.output) : undefined;
							return (
								<div
									key={part.toolCallId}
									className="rounded-lg border border-kumo-line bg-kumo-tint/30 text-xs"
								>
									<details>
										<summary className="cursor-pointer px-3 py-2">
											<span className="font-medium">
												{toolLabels[name] ?? name.replaceAll("_", " ")}
											</span>
											<span className="ml-2 text-kumo-subtle">
												{failed ? "Failed" : done ? "Done" : "Working…"}
											</span>
										</summary>
										<div className="space-y-2 border-t border-kumo-line p-3">
											<p className="text-kumo-subtle">Request</p>
											<pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
												{JSON.stringify(part.input, null, 2)}
											</pre>
											{done && (
												<>
													<p className="text-kumo-subtle">Result</p>
													<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
														{JSON.stringify(part.output, null, 2)}
													</pre>
												</>
											)}
											{failed && (
												<p role="alert" className="text-red-600">
													{part.errorText}
												</p>
											)}
										</div>
									</details>
									{draft && (
										<div className="border-t border-kumo-line px-3 py-2">
											<button
												className="font-medium text-kumo-link hover:underline"
												onClick={() => void openDraft(draft)}
											>
												Review draft
											</button>
										</div>
									)}
								</div>
							);
						})}
						{message.metadata?.status === "failed" && (
							<p className="text-xs text-kumo-subtle">
								This run did not fully complete. Review its tool results and any
								saved drafts.
							</p>
						)}
					</article>
				))}
				{busy && (
					<p className="animate-pulse text-xs text-kumo-subtle">
						{status === "submitted" ? "Thinking…" : "Working…"}
					</p>
				)}
				{!busy && running && (
					<p className="text-xs text-kumo-subtle">
						The assistant is working. Saved results will appear here.
					</p>
				)}
				<div ref={bottom} />
			</div>
			<form
				className="space-y-3 border-t border-kumo-line p-4"
				onSubmit={(event) => {
					event.preventDefault();
					void send(prompt);
				}}
			>
				{(error || draftError) && (
					<p role="alert" className="text-sm text-red-600">
						{draftError || error?.message}
					</p>
				)}
				{!modelAvailable && (
					<p role="alert" className="text-xs text-kumo-subtle">
						This model is unavailable. Choose an available model or configure
						its provider in Settings.
					</p>
				)}
				{selectedEmailId && (
					<Button
						variant="secondary"
						size="sm"
						disabled={running || !modelAvailable}
						onClick={() =>
							void send(
								"Read the selected email and its conversation, then save a draft reply for my review.",
							)
						}
					>
						Draft reply to selected email
					</Button>
				)}
				<div className="rounded-xl border border-kumo-line bg-kumo-base p-2 focus-within:ring-1 focus-within:ring-kumo-line">
					<textarea
						aria-label="Message email agent"
						rows={3}
						maxLength={8000}
						className="block w-full resize-none bg-transparent p-2 text-sm outline-none"
						placeholder="Ask about your inbox…"
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
					<div className="flex items-center justify-between gap-2">
						<select
							aria-label="Agent model"
							className="min-w-0 max-w-[75%] rounded bg-kumo-base p-2 text-xs text-kumo-subtle"
							value={selectedModel}
							disabled={running}
							onChange={(event) => setAgentModel(mailboxId, event.target.value)}
						>
							<option value="">
								Default:{" "}
								{models.find((m) => m.id === state.settings.model)?.name ??
									state.settings.model}
							</option>
							{selectedModel && !models.some((m) => m.id === selectedModel) && (
								<option value={selectedModel} disabled>
									{selectedModel} (unavailable)
								</option>
							)}
							{Array.from(new Set(models.map((m) => m.provider))).map(
								(provider) => (
									<optgroup key={provider} label={provider}>
										{models
											.filter((m) => m.provider === provider)
											.map((model) => (
												<option
													key={model.id}
													value={model.id}
													disabled={!model.selectable}
												>
													{model.name}
													{!model.available
														? " (retired)"
														: !model.selectable
															? " (not configured)"
															: ""}
												</option>
											))}
									</optgroup>
								),
							)}
						</select>
						<Button
							type="submit"
							size="sm"
							disabled={!prompt.trim() || running || !modelAvailable}
						>
							{running ? "Working…" : "Send"}
						</Button>
					</div>
				</div>
				<p className="text-center text-xs text-kumo-subtle">
					Drafts stay in your inbox for review. The assistant never sends email.
				</p>
			</form>
		</>
	);
}
