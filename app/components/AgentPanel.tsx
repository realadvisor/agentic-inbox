import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { useUIStore } from "~/hooks/useUIStore";
import api from "~/services/api";
import {
	AGENT_MODELS,
	type AgentSettings,
	type AgentState,
	type AgentEvent,
	type AgentAction,
} from "../../shared/agent";

const endpoint = (mailbox: string) =>
	`/api/v1/mailboxes/${encodeURIComponent(mailbox)}/agent`;
async function jsonRequest<T>(url: string, body?: unknown): Promise<T> {
	const response = await fetch(url, {
		method: body ? "PUT" : "GET",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
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
	const { selectedEmailId, openComposeModal } = useUIStore();
	const state = useQuery({
		queryKey: ["agent", mailboxId],
		queryFn: () => jsonRequest<AgentState>(endpoint(mailboxId)),
		refetchInterval: 10000,
	});
	const [settings, setSettings] = useState<AgentSettings>();
	const [editing, setEditing] = useState(false);
	const [saving, setSaving] = useState(false);
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
	const persistSettings = async (next: AgentSettings) => {
		setSaving(true);
		setError("");
		try {
			await jsonRequest(`${endpoint(mailboxId)}/settings`, next);
			await state.refetch();
			setEditing(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not save settings");
		} finally {
			setSaving(false);
		}
	};
	const send = async (text: string) => {
		if (busy || !text.trim()) return;
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
						value={current?.model ?? AGENT_MODELS[0].id}
						disabled={!current || saving || !!running}
						onChange={(event) =>
							current &&
							void persistSettings({
								...current,
								model: event.target.value as AgentSettings["model"],
							})
						}
					>
						{AGENT_MODELS.map((model) => (
							<option key={model.id} value={model.id}>
								{model.name}
							</option>
						))}
					</select>
				</label>
				<p className="text-xs text-kumo-subtle">
					Saved for this mailbox. Used for chat and automatic drafts.
				</p>
				<Button
					variant="ghost"
					size="sm"
					disabled={!current}
					onClick={() => {
						setSettings(current);
						setEditing(!editing);
					}}
				>
					Agent settings
				</Button>
				{editing && settings && (
					<form
						className="space-y-3"
						onSubmit={(event) => {
							event.preventDefault();
							void persistSettings(settings);
						}}
					>
						<label className="block text-sm">
							Writing instructions
							<textarea
								aria-label="Agent writing instructions"
								rows={4}
								maxLength={8000}
								className="mt-1 w-full rounded border border-kumo-line bg-kumo-base p-2"
								placeholder="Tone, business context, and how to handle requests…"
								value={settings.system_prompt}
								onChange={(event) =>
									setSettings({
										...settings,
										system_prompt: event.target.value,
									})
								}
							/>
						</label>
						<label className="flex items-start gap-2 text-sm">
							<input
								type="checkbox"
								className="mt-1"
								checked={settings.auto_draft}
								disabled={
									!state.data?.autoDraftAvailable || !state.data?.available
								}
								onChange={(event) =>
									setSettings({ ...settings, auto_draft: event.target.checked })
								}
							/>
							Automatically draft replies to new emails
						</label>
						<p className="text-xs text-kumo-subtle">
							Applies to future incoming mail. Drafts wait for your review and
							are never sent automatically.
						</p>
						<Button type="submit" disabled={saving}>
							{saving ? "Saving…" : "Save settings"}
						</Button>
					</form>
				)}
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
						Workers AI is not configured in this environment.
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
								{AGENT_MODELS.find((m) => m.id === turn.model)?.name ??
									turn.model}
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
						disabled={!!running || !state.data?.available}
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
					disabled={!!running || !state.data?.available}
					onChange={(event) => setPrompt(event.target.value)}
				/>
				<Button
					type="submit"
					disabled={!prompt.trim() || !!running || !state.data?.available}
				>
					{running ? "Working…" : "Ask agent"}
				</Button>
			</form>
		</aside>
	);
}
