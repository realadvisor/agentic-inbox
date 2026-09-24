import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { Button } from "@cloudflare/kumo";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import {
	type AgentState,
	type AgentEvent,
	type AgentAction,
} from "../../shared/agent";

const endpoint = (mailbox: string) =>
	`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/agent`;
async function jsonRequest<T>(url: string): Promise<T> {
	const response = await fetch(url);
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || "Could not load the agent");
	}
	return response.json();
}

export default function AgentPanel({
	mailboxId,
	close,
}: {
	mailboxId: string;
	close: () => void;
}) {
	const client = useQueryClient();
	const { selectedEmailId, openComposeModal, agentModels, setAgentModel } =
		useUIStore();
	const state = useQuery({
		queryKey: ["agent", mailboxId],
		queryFn: () => jsonRequest<AgentState>(endpoint(mailboxId)),
		refetchInterval: 10000,
	});
	const selectedModel = agentModels[mailboxId] ?? "";
	const effectiveModel = selectedModel || state.data?.settings.model;
	const models = state.data?.catalog.models ?? [];
	const modelAvailable = models.some(
		(m) => m.id === effectiveModel && m.selectable,
	);
	const [prompt, setPrompt] = useState("");
	const [busy, setBusy] = useState(false);
	const [activeTurn, setActiveTurn] = useState<{
		id: string;
		prompt: string;
	}>();
	const [answer, setAnswer] = useState("");
	const [actions, setActions] = useState<AgentAction[]>([]);
	const [error, setError] = useState("");
	const controller = useRef<AbortController | null>(null);
	const bottom = useRef<HTMLDivElement>(null);
	useEffect(() => () => controller.current?.abort(), []);
	useEffect(() => {
		bottom.current?.scrollIntoView({ block: "nearest" });
	}, [answer, actions.length, state.data?.turns.length]);
	const send = async (text: string) => {
		if (busy || !text.trim() || !modelAvailable) return;
		const turn = { id: crypto.randomUUID(), prompt: text };
		setActiveTurn(turn);
		setBusy(true);
		setError("");
		setAnswer("");
		setActions([]);
		const abort = new AbortController();
		controller.current = abort;
		let complete = false;
		try {
			const response = await fetch(`${endpoint(mailboxId)}/chat`, {
				method: "POST",
				signal: abort.signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...turn,
					model: effectiveModel,
					...(selectedEmailId ? { emailId: selectedEmailId } : {}),
				}),
			});
			if (!response.ok) {
				const error = await response.json().catch(() => ({}));
				throw new Error(error.error || "Could not start the agent");
			}
			setPrompt("");
			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (!abort.signal.aborted) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf("\n")) !== -1) {
					const event: AgentEvent = JSON.parse(buffer.slice(0, newline));
					buffer = buffer.slice(newline + 1);
					if (event.type === "text")
						setAnswer((previous) => previous + event.text);
					if (event.type === "action")
						setActions((previous) => [...previous, event.action]);
					if (event.type === "error") {
						setError(event.message);
						complete = true;
					}
					if (event.type === "done") complete = true;
				}
			}
			if (!complete)
				throw new Error(
					"Connection interrupted. Check agent history before trying again.",
				);
		} catch (err) {
			if (!abort.signal.aborted)
				setError(err instanceof Error ? err.message : "Agent request failed");
		} finally {
			if (!abort.signal.aborted) {
				await Promise.all([
					state.refetch(),
					client.invalidateQueries({ queryKey: ["emails", mailboxId] }),
					client.invalidateQueries({ queryKey: ["folders", mailboxId] }),
					client.invalidateQueries({ queryKey: ["search", mailboxId] }),
				]);
				setBusy(false);
				setAnswer("");
				setActions([]);
			}
		}
	};
	const openDraft = async (id: string) => {
		try {
			const email = await api.getEmail(mailboxId, id);
			if (email.delivery_status !== "draft")
				throw new Error("This draft has already been sent or removed");
			openComposeModal({ mode: "new", draftEmail: email });
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not open draft");
		}
	};
	const actionList = (items: AgentAction[]) =>
		items.map((action, index) => {
			let draft: string | undefined;
			try {
				draft = JSON.parse(action.result).draft_id;
			} catch {
				/* Older entries remain readable. */
			}
			return (
				<div key={index} className="mt-2 text-xs text-kumo-subtle">
					{action.tool.replaceAll("_", " ")}
					{draft && (
						<button
							className="ml-2 underline text-kumo-link"
							onClick={() => void openDraft(draft!)}
						>
							Review draft
						</button>
					)}
				</div>
			);
		});
	const current = state.data?.settings;
	const running =
		busy || state.data?.turns.some((turn) => turn.status === "running");
	return (
		<aside
			aria-label="Email agent"
			className="fixed inset-0 z-40 flex flex-col bg-kumo-base text-kumo-default md:static md:z-0 md:w-[390px] md:shrink-0 border-l border-kumo-line"
		>
			<div className="flex items-center justify-between p-4 border-b border-kumo-line">
				<h2 className="font-semibold">Email agent</h2>
				<Button
					variant="ghost"
					size="sm"
					onClick={close}
					aria-label="Close email agent"
				>
					Close
				</Button>
			</div>
			<div className="p-4 space-y-3 border-b border-kumo-line">
				<label className="block text-sm">
					Model
					<select
						aria-label="Agent model"
						className="mt-1 block w-full rounded border border-kumo-line bg-kumo-base p-2"
						value={selectedModel}
						disabled={!current || !!running}
						onChange={(event) => setAgentModel(mailboxId, event.target.value)}
					>
						<option value="">
							Default:{" "}
							{models.find((m) => m.id === current?.model)?.name ??
								current?.model ??
								"Loading…"}
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
				</label>
				<p className="text-xs text-kumo-subtle">
					Choose a model for this chat. Automatic drafts use the default in
					settings.
				</p>
				{current && !modelAvailable && (
					<p role="alert" className="text-sm text-kumo-subtle">
						This model is unavailable. Choose another model or configure its
						provider.
					</p>
				)}
				<Link
					className="text-sm underline text-kumo-link"
					to={`/mailbox/${encodeURIComponent(mailboxId)}/settings?tab=models`}
					onClick={close}
				>
					Model &amp; agent settings
				</Link>
			</div>
			<div className="flex-1 overflow-y-auto p-4 space-y-4" aria-live="polite">
				{state.isLoading && <p>Loading agent…</p>}
				{state.error && (
					<p role="alert">
						Could not load the agent.{" "}
						<button onClick={() => void state.refetch()} className="underline">
							Retry
						</button>
					</p>
				)}
				{state.data && !state.data.available && (
					<p className="text-sm text-kumo-subtle">
						No AI provider is configured in this environment.
					</p>
				)}
				{state.data?.turns.length === 0 && (
					<div className="text-sm text-kumo-subtle">
						<p>Ask about this inbox, find a conversation, or draft a reply.</p>
						<p className="mt-2">
							Review and send drafts yourself from the composer.
						</p>
					</div>
				)}
				{state.data?.turns
					.filter((turn) => !busy || turn.id !== activeTurn?.id)
					.map((turn) => (
						<article key={turn.id} className="space-y-2 text-sm">
							<div className="rounded-lg bg-kumo-tint p-3 whitespace-pre-wrap">
								{turn.prompt}
							</div>
							<p className="text-xs text-kumo-subtle">
								{models.find((m) => m.id === turn.model)?.name ?? turn.model}
							</p>
							<p className="whitespace-pre-wrap">
								{turn.answer ||
									(turn.status === "running"
										? "Working…"
										: "This run was interrupted. Check its saved drafts.")}
							</p>
							{turn.status === "failed" && (
								<p className="text-xs text-kumo-subtle">Could not finish</p>
							)}
							{actionList(turn.actions)}
						</article>
					))}
				{busy && (
					<div className="text-sm whitespace-pre-wrap">
						<div className="rounded-lg bg-kumo-tint p-3 mb-2">
							{activeTurn?.prompt}
						</div>
						{answer || "Working…"}
						{actionList(actions)}
					</div>
				)}
				<div ref={bottom} />
			</div>
			<form
				className="p-4 border-t border-kumo-line space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					void send(prompt);
				}}
			>
				{error && (
					<p role="alert" className="text-sm text-red-600">
						{error}
					</p>
				)}
				{selectedEmailId && (
					<Button
						variant="secondary"
						size="sm"
						disabled={!!running || !modelAvailable}
						onClick={() =>
							void send(
								"Read the selected email and its conversation, then save a draft reply for my review.",
							)
						}
					>
						Draft reply to selected email
					</Button>
				)}
				<textarea
					aria-label="Message email agent"
					rows={3}
					maxLength={8000}
					className="block w-full rounded border border-kumo-line bg-kumo-base p-2 text-sm"
					placeholder="Ask the agent…"
					value={prompt}
					disabled={!!running || !modelAvailable}
					onChange={(event) => setPrompt(event.target.value)}
				/>
				<Button
					type="submit"
					disabled={!prompt.trim() || !!running || !modelAvailable}
				>
					{running ? "Working…" : "Ask agent"}
				</Button>
			</form>
		</aside>
	);
}
