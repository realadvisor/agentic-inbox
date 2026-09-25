import {
	Textarea as KumoTextarea,
	Checkbox as KumoCheckbox,
} from "@cloudflare/kumo";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Input, Loader } from "@cloudflare/kumo";
import {
	ArrowClockwiseIcon,
	CpuIcon,
	SparkleIcon,
} from "@phosphor-icons/react";
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
	if (state.isLoading)
		return (
			<div
				role="status"
				className="flex items-center justify-center gap-3 rounded-xl border border-kumo-line bg-kumo-base p-10 text-sm text-kumo-subtle"
			>
				<Loader size="sm" /> Loading models…
			</div>
		);
	if (!state.data)
		return (
			<p
				role="alert"
				className="rounded-xl border border-kumo-line bg-kumo-base p-5 text-sm text-kumo-danger"
			>
				Could not load models.{" "}
				<button className="underline" onClick={() => void state.refetch()}>
					Retry
				</button>
			</p>
		);
	const { catalog, settings } = state.data;
	const models = catalog.models
		.filter((m) =>
			`${m.name} ${m.id} ${m.provider}`
				.toLowerCase()
				.includes(search.toLowerCase()),
		)
		.sort(
			(a, b) =>
				Number(b.selectable) - Number(a.selectable) ||
				Number(b.id === settings.model) - Number(a.id === settings.model),
		);
	const defaultModel = catalog.models.find((m) => m.id === settings.model);
	return (
		<div className="space-y-6 text-kumo-default">
			<section
				className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden"
				aria-labelledby="models-heading"
			>
				<div className="flex flex-wrap items-center justify-between gap-3 p-5">
					<div className="flex items-center gap-3">
						<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle">
							<CpuIcon size={21} />
						</div>
						<div>
							<h2 id="models-heading" className="text-sm font-semibold">
								Models{" "}
								<span className="ml-1.5 text-xs font-normal text-kumo-subtle">
									{catalog.models.length}
								</span>
							</h2>
							<p className="mt-0.5 text-xs text-kumo-subtle">
								Choose the default model for this mailbox.
							</p>
						</div>
					</div>
					<Button
						variant="secondary"
						size="sm"
						icon={<ArrowClockwiseIcon size={14} />}
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
				<div className="space-y-2 border-y border-kumo-line bg-kumo-tint px-5 py-3">
					<p className="text-xs text-kumo-subtle">
						Default for this mailbox:{" "}
						<strong>{defaultModel?.name ?? settings.model}</strong>. Used for
						new chats and automatic drafts. You can choose a different model in
						chat.
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
				</div>
				<div className="p-5">
					<Input
						aria-label="Search models"
						placeholder="Search models or providers…"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						className="w-full"
					/>
				</div>
				<div
					className="max-h-96 overflow-y-auto border-t border-kumo-line divide-y divide-kumo-line"
					aria-label="Available models"
				>
					{models.map((model) => (
						<div
							key={model.id}
							className={`flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 px-5 py-3.5 transition-colors hover:bg-kumo-tint ${model.id === settings.model ? "bg-kumo-tint" : ""}`}
						>
							<div className="min-w-0 flex-1">
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
								className="shrink-0"
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
						<p className="p-5 text-sm text-kumo-subtle">No matching models.</p>
					)}
				</div>
			</section>
			<form
				className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden"
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
				<div className="flex items-center gap-3 p-5 border-b border-kumo-line">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle">
						<SparkleIcon size={21} />
					</div>
					<div>
						<h2 className="text-sm font-semibold">Email agent</h2>
						<p className="mt-0.5 text-xs text-kumo-subtle">
							Customize how the agent writes and prepares replies.
						</p>
					</div>
				</div>
				<div className="space-y-4 p-5">
					<label className="block text-sm font-medium">
						Writing instructions
						<KumoTextarea
							aria-label="Agent writing instructions"
							rows={4}
							maxLength={8000}
							className="mt-2 w-full font-normal"
							placeholder="Tone, business context, and how to handle requests…"
							value={instructions ?? settings.system_prompt}
							onChange={(event) => setInstructions(event.target.value)}
						/>
					</label>
					<div className="flex items-start gap-2 text-sm">
						<KumoCheckbox
							className="mt-1"
							checked={automatic ?? settings.auto_draft}
							disabled={
								busy ||
								(!(automatic ?? settings.auto_draft) &&
									(!state.data.autoDraftAvailable || !defaultModel?.selectable))
							}
							onCheckedChange={(event) => setAutomatic(event)}
							label={<>Automatically draft replies to new emails</>}
						/>
					</div>
					<p className="text-xs text-kumo-subtle">
						Applies to future incoming mail. Drafts wait for your review and are
						never sent automatically.
					</p>
				</div>
				<div className="flex justify-end border-t border-kumo-line bg-kumo-tint px-5 py-3">
					<Button type="submit" variant="primary" size="sm" disabled={busy}>
						Save agent settings
					</Button>
				</div>
			</form>
			{error && (
				<p
					role="alert"
					className="rounded-lg border border-kumo-line bg-kumo-base p-3 text-sm text-kumo-danger"
				>
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
