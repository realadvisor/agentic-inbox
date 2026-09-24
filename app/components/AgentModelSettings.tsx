import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import type { AgentSettings, AgentState } from "../../shared/agent";

async function request<T>(
	url: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	const response = await fetch(url, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || "Could not update agent settings");
	}
	return response.json();
}

export default function AgentModelSettings({
	mailboxId,
}: {
	mailboxId: string;
}) {
	const client = useQueryClient();
	const endpoint = `/api/v1/mailboxes/${encodeURIComponent(mailboxId)}/agent`;
	const state = useQuery({
		queryKey: ["agent", mailboxId],
		queryFn: () => request<AgentState>(endpoint),
	});
	const [search, setSearch] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [instructions, setInstructions] = useState<string>();
	const [automatic, setAutomatic] = useState<boolean>();
	const update = async (work: () => Promise<unknown>, success: string) => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await work();
			await client.invalidateQueries({ queryKey: ["agent"] });
			setNotice(success);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not save settings");
		} finally {
			setBusy(false);
		}
	};
	const save = async (patch: Partial<AgentSettings>) => {
		// Fetch current settings so a model change does not overwrite writing preferences.
		const current = await request<AgentState>(endpoint);
		return request(`${endpoint}/settings`, "PUT", {
			...current.settings,
			...patch,
		});
	};
	if (state.isLoading) return <p>Loading models…</p>;
	if (!state.data)
		return (
			<p role="alert">
				Could not load models.{" "}
				<button className="underline" onClick={() => void state.refetch()}>
					Retry
				</button>
			</p>
		);
	const { catalog, settings } = state.data;
	const models = catalog.models.filter((m) =>
		`${m.name} ${m.id} ${m.provider}`
			.toLowerCase()
			.includes(search.toLowerCase()),
	);
	const defaultModel = catalog.models.find((m) => m.id === settings.model);
	return (
		<div className="space-y-6 text-kumo-default">
			<section className="space-y-3">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h2 className="font-medium">Models</h2>
					<Button
						variant="secondary"
						disabled={busy}
						onClick={() =>
							void update(
								() => request("/api/v1/agent/models/refresh", "POST", {}),
								"Model list refreshed",
							)
						}
					>
						{busy ? "Updating…" : "Refresh model list"}
					</Button>
				</div>
				<p className="text-sm text-kumo-subtle">
					Default for this mailbox:{" "}
					<strong>{defaultModel?.name ?? settings.model}</strong>. Used for new
					chats and automatic drafts. You can choose a different model in chat.
				</p>
				<p className="text-xs text-kumo-subtle">
					{catalog.refreshed_at
						? `Catalog refreshed ${new Date(catalog.refreshed_at).toLocaleString()}`
						: "Refresh to load Anthropic, OpenAI, and other supported gateway models."}
				</p>
				{!catalog.gatewayConfigured && (
					<p className="text-sm text-kumo-subtle">
						AI Gateway is not configured. Gateway models can be browsed after
						refreshing, but require an administrator to enable the provider
						before use.
					</p>
				)}
				{!defaultModel?.selectable && (
					<p role="alert" className="text-sm">
						The saved default is unavailable. Select an available model below.
					</p>
				)}
				<input
					aria-label="Search models"
					placeholder="Search models or providers…"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					className="w-full rounded border border-kumo-line bg-kumo-base p-2 text-sm"
				/>
				<div
					className="max-h-96 overflow-y-auto rounded-lg border border-kumo-line divide-y divide-kumo-line"
					aria-label="Available models"
				>
					{models.map((model) => (
						<div
							key={model.id}
							className="flex items-center justify-between gap-3 p-3"
						>
							<div className="min-w-0">
								<p className="text-sm font-medium break-words">{model.name}</p>
								<p className="text-xs text-kumo-subtle break-all">
									{model.id} ·{" "}
									{model.source === "workers" ? "Workers AI" : "AI Gateway"}
								</p>
								{!model.selectable && (
									<p className="text-xs text-kumo-subtle">
										{!model.available
											? "No longer in the current catalog"
											: "Provider not configured"}
									</p>
								)}
							</div>
							<Button
								size="sm"
								variant={model.id === settings.model ? "primary" : "secondary"}
								disabled={
									busy || !model.selectable || model.id === settings.model
								}
								onClick={() =>
									void update(
										() => save({ model: model.id }),
										`Default set to ${model.name}`,
									)
								}
								aria-label={`Set ${model.name} as default`}
							>
								{model.id === settings.model ? "Default" : "Set default"}
							</Button>
						</div>
					))}
					{!models.length && (
						<p className="p-3 text-sm text-kumo-subtle">No matching models.</p>
					)}
				</div>
			</section>
			<form
				className="space-y-3 border-t border-kumo-line pt-5"
				onSubmit={(event) => {
					event.preventDefault();
					void update(async () => {
						await save({
							system_prompt: instructions ?? settings.system_prompt,
							auto_draft: automatic ?? settings.auto_draft,
						});
						setInstructions(undefined);
						setAutomatic(undefined);
					}, "Agent settings saved");
				}}
			>
				<h2 className="font-medium">Email agent</h2>
				<label className="block text-sm">
					Writing instructions
					<textarea
						aria-label="Agent writing instructions"
						rows={4}
						maxLength={8000}
						className="mt-1 w-full rounded border border-kumo-line bg-kumo-base p-2"
						placeholder="Tone, business context, and how to handle requests…"
						value={instructions ?? settings.system_prompt}
						onChange={(event) => setInstructions(event.target.value)}
					/>
				</label>
				<label className="flex items-start gap-2 text-sm">
					<input
						type="checkbox"
						className="mt-1"
						checked={automatic ?? settings.auto_draft}
						disabled={
							busy ||
							(!(automatic ?? settings.auto_draft) &&
								(!state.data.autoDraftAvailable || !defaultModel?.selectable))
						}
						onChange={(event) => setAutomatic(event.target.checked)}
					/>
					Automatically draft replies to new emails
				</label>
				<p className="text-xs text-kumo-subtle">
					Applies to future incoming mail. Drafts wait for your review and are
					never sent automatically.
				</p>
				<Button type="submit" disabled={busy}>
					Save agent settings
				</Button>
			</form>
			{error && (
				<p role="alert" className="text-sm text-red-600">
					{error}
				</p>
			)}
			{notice && (
				<p role="status" className="text-sm text-kumo-subtle">
					{notice}
				</p>
			)}
		</div>
	);
}
