import { AppSelect } from "./AppSelect";
import { useTags } from "~/queries/tags";
import { Button, Input, Checkbox, Loader } from "@cloudflare/kumo";
import { useState } from "react";
import { WebhooksLogoIcon, PlusIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
const eventLabels: Record<string, string> = {
	"conversation.matched": "Tag conditions matched",
	"email.received": "Email received",
	"email.sent": "Email sent",
	"conversation.tags_changed": "Tags changed",
	"conversation.classified": "Classification completed",
	"conversation.status_changed": "Status changed",
};
const events = [
	"email.received",
	"email.sent",
	"conversation.tags_changed",
	"conversation.classified",
	"conversation.status_changed",
	"conversation.matched",
];
type Endpoint = {
	id: string;
	url: string;
	events: string[];
	enabled: boolean;
	include_tag_ids: string[];
	exclude_tag_ids: string[];
	tag_match: "any" | "all";
};
async function request<T>(
	path: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	const r = await fetch("/api/v1/webhooks/" + path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const d = await r.json();
	if (!r.ok) throw new Error(d.error ?? "Webhook request failed");
	return d;
}
export default function WebhookSettings({ mailboxId }: { mailboxId: string }) {
	const tags = useTags();
	const [included, setIncluded] = useState<string[]>([]);
	const [excluded, setExcluded] = useState<string[]>([]);
	const [match, setMatch] = useState("any");
	const tagLabel = (id: string) => {
		const t = tags.data?.find((t) => t.id === id);
		return t
			? `${t.group_name ? t.group_name + ": " : ""}${t.name}`
			: "Unavailable tag";
	};
	const base = encodeURIComponent(mailboxId),
		qc = useQueryClient();
	const [editing, setEditing] = useState<Endpoint | null | undefined>(),
		[url, setUrl] = useState(""),
		[selected, setSelected] = useState<string[]>(["conversation.classified"]),
		[secret, setSecret] = useState(""),
		[history, setHistory] = useState("");
	const list = useQuery({
		queryKey: ["webhooks", base],
		queryFn: () => request<Endpoint[]>(base),
	});
	const deliveries = useQuery({
		queryKey: ["webhook-deliveries", base, history],
		queryFn: () =>
			request<
				{
					id: string;
					status: string;
					type: string;
					payload: unknown;
					history: {
						attempt: number;
						status_code: number;
						error: string;
						response: string;
						duration_ms: number;
					}[];
				}[]
			>(`${base}/${history}/deliveries`),
		enabled: !!history,
		refetchInterval: 5000,
	});
	const action = useMutation({
		mutationFn: async ({
			path,
			method,
			body,
		}: {
			path: string;
			method: string;
			body?: unknown;
		}) => request<{ secret?: string }>(path, method, body),
		onSuccess: async (data) => {
			if (data.secret) setSecret(data.secret);
			await qc.invalidateQueries({ queryKey: ["webhooks"] });
			await qc.invalidateQueries({ queryKey: ["webhook-deliveries"] });
		},
	});
	const edit = (e: Endpoint | null) => {
		setEditing(e);
		setUrl(e?.url ?? "");
		setSelected(e?.events ?? ["conversation.classified"]);
		setIncluded(e?.include_tag_ids ?? []);
		setExcluded(e?.exclude_tag_ids ?? []);
		setMatch(e?.tag_match ?? "any");
		setSecret("");
	};
	return (
		<section className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
			<div className="flex flex-wrap items-center justify-between gap-3 p-5">
				<div className="flex items-center gap-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle">
						<WebhooksLogoIcon size={21} />
					</div>
					<div>
						<h2 className="text-sm font-semibold">Webhooks</h2>
						<p className="mt-0.5 text-xs text-kumo-subtle">
							Send mailbox events to your integrations.
						</p>
					</div>
				</div>
				<Button
					size="sm"
					variant="primary"
					icon={<PlusIcon size={14} />}
					disabled={editing !== undefined || action.isPending}
					onClick={() => edit(null)}
				>
					Add endpoint
				</Button>
			</div>
			{(action.error || list.error) && (
				<p role="alert" className="px-5 py-3 text-sm text-kumo-danger">
					{(action.error || list.error)?.message}
				</p>
			)}
			{secret && (
				<div className="border-t border-kumo-line bg-kumo-tint/30 p-5 text-sm">
					<p>Copy this signing secret now. It is shown only once.</p>
					<code className="block break-all text-xs my-2">{secret}</code>
					<Button
						size="sm"
						onClick={() => navigator.clipboard.writeText(secret)}
					>
						Copy secret
					</Button>
				</div>
			)}
			{editing !== undefined && (
				<form
					className="border-t border-kumo-line bg-kumo-tint/30 p-5 space-y-4"
					onSubmit={async (e) => {
						e.preventDefault();
						await action
							.mutateAsync({
								path: editing ? `${base}/${editing.id}` : base,
								method: editing ? "PUT" : "POST",
								body: {
									url,
									events: selected,
									include_tag_ids: included,
									exclude_tag_ids: excluded,
									tag_match: match,
									enabled: editing?.enabled ?? true,
								},
							})
							.then(() => setEditing(undefined))
							.catch(() => {});
					}}
				>
					<Input
						label="Endpoint URL"
						placeholder="https://your-app.com/webhooks"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						required
					/>
					<fieldset className="border-t border-kumo-line pt-3 space-y-2">
						<legend className="text-sm font-medium">Events</legend>
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
							{events.map((event) => (
								<Checkbox
									key={event}
									label={eventLabels[event]}
									checked={selected.includes(event)}
									onCheckedChange={(value) =>
										setSelected((prev) =>
											value
												? [...prev, event]
												: prev.filter((v) => v !== event),
										)
									}
								/>
							))}
						</div>
						{selected.includes("conversation.classified") && (
							<p className="text-xs text-kumo-subtle">
								Jev finishes classification, then the tag conditions below are
								checked.
							</p>
						)}
						{selected.includes("conversation.matched") && (
							<p className="text-xs text-kumo-subtle">
								Send when a conversation starts matching these tags, including
								tags added by Jev. Existing matches are skipped. Sends again
								only after it stops matching and matches again.
							</p>
						)}
					</fieldset>
					<section
						aria-label="Tag conditions"
						className="rounded-lg border border-kumo-line bg-kumo-base"
					>
						{[
							{
								label: "Include tags",
								title: "Conversation has",
								values: included,
								other: excluded,
								set: setIncluded,
							},
							{
								label: "Exclude tags",
								title: "But does not have",
								values: excluded,
								other: included,
								set: setExcluded,
							},
						].map((group) => (
							<div
								key={group.label}
								className="min-w-0 p-3 space-y-2 border-b border-kumo-line last:border-b-0"
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div className="text-sm font-medium">{group.title}</div>
									{group.label === "Include tags" ? (
										<div
											role="group"
											aria-label="Match included tags"
											className="inline-flex rounded-md bg-kumo-control p-0.5 ring-1 ring-kumo-line"
										>
											{[
												{ value: "any", label: "Any tag" },
												{ value: "all", label: "All tags" },
											].map((option) => (
												<button
													key={option.value}
													type="button"
													aria-pressed={match === option.value}
													onClick={() => setMatch(option.value)}
													className={`rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-blue-500 ${match === option.value ? "bg-kumo-base text-kumo-default shadow-sm" : "text-kumo-subtle hover:text-kumo-default"}`}
												>
													{option.label}
												</button>
											))}
										</div>
									) : (
										<span className="text-xs text-kumo-subtle">Optional</span>
									)}
								</div>
								<AppSelect
									label={group.label}
									value=""
									disabled={tags.isLoading || !!tags.error}
									options={[
										{
											value: "",
											label:
												group.label === "Include tags"
													? "+ Add a tag"
													: "+ Add an exclusion",
										},
										...(tags.data ?? [])
											.filter(
												(t) =>
													!group.values.includes(t.id) &&
													!group.other.includes(t.id),
											)
											.map((t) => ({ value: t.id, label: tagLabel(t.id) })),
									]}
									onChange={(id) => {
										if (id) group.set([...group.values, id]);
									}}
								/>
								<div className="flex flex-wrap gap-1">
									{group.values.map((id) => (
										<Button
											key={id}
											className="max-w-full"
											title={tagLabel(id)}
											size="sm"
											variant="secondary"
											type="button"
											aria-label={`Remove ${tagLabel(id)} from ${group.label.toLowerCase()}`}
											onClick={() =>
												group.set(group.values.filter((v) => v !== id))
											}
										>
											<span
												aria-hidden="true"
												className="size-2 shrink-0 rounded-full"
												style={{
													backgroundColor:
														tags.data?.find((t) => t.id === id)?.color ??
														"#94a3b8",
												}}
											/>
											<span className="truncate">{tagLabel(id)}</span>
											<span aria-hidden="true">×</span>
										</Button>
									))}
								</div>
							</div>
						))}
					</section>
					{tags.error && (
						<p role="alert" className="text-sm text-kumo-danger">
							Could not load tags. Reload before changing filters.
						</p>
					)}
					<p className="text-xs text-kumo-subtle" aria-live="polite">
						{included.length || excluded.length
							? `Matches ${included.length === 1 ? "the selected tag" : included.length ? `${match === "all" ? "all" : "any"} of ${included.length} selected tags` : "any conversation"}${excluded.length ? `, excluding ${excluded.length} tag${excluded.length === 1 ? "" : "s"}` : ""}.`
							: selected.includes("conversation.matched")
								? "Add at least one tag or exclusion to define a condition."
								: "No conditions added. All selected events will be sent."}
					</p>
					<div className="flex flex-row-reverse justify-start gap-2 border-t border-kumo-line pt-4">
						<Button
							type="submit"
							variant="primary"
							size="sm"
							disabled={
								!selected.length ||
								(selected.includes("conversation.matched") &&
									!included.length &&
									!excluded.length) ||
								action.isPending
							}
						>
							Save endpoint
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={action.isPending}
							onClick={() => setEditing(undefined)}
						>
							Cancel
						</Button>
					</div>
				</form>
			)}
			{list.isPending && (
				<div className="flex justify-center border-t border-kumo-line p-10">
					<Loader />
				</div>
			)}
			{list.data?.length === 0 && editing === undefined && (
				<div className="border-t border-kumo-line px-5 py-10 text-center">
					<WebhooksLogoIcon
						size={28}
						className="mx-auto mb-3 text-kumo-subtle"
					/>
					<p className="text-sm font-medium">No endpoints yet</p>
					<p className="mt-1 text-xs text-kumo-subtle">
						Add a URL and choose the events to send.
					</p>
				</div>
			)}
			{list.data?.map((e) => (
				<div
					key={e.id}
					className="border-t border-kumo-line px-5 py-3 space-y-2"
				>
					<div className="flex flex-wrap items-center gap-2">
						<span className="min-w-0 break-all text-sm font-medium">
							{e.url}
						</span>
						<span className="inline-flex items-center gap-1.5 rounded-md bg-kumo-tint px-1.5 py-0.5 text-[11px] text-kumo-subtle">
							<span
								className={`h-1.5 w-1.5 rounded-full ${e.enabled ? "bg-emerald-500" : "bg-kumo-subtle"}`}
							/>
							{e.enabled ? "Enabled" : "Disabled"}
						</span>
					</div>
					<p className="text-xs text-kumo-subtle">
						{e.events.map((event) => eventLabels[event] ?? event).join(", ")}
					</p>
					{(e.include_tag_ids.length > 0 || e.exclude_tag_ids.length > 0) && (
						<p className="text-xs text-kumo-subtle">
							{e.include_tag_ids.length > 0 &&
								`Match ${e.tag_match}: ${e.include_tag_ids.map(tagLabel).join(", ")}`}
							{e.exclude_tag_ids.length > 0 &&
								` · Exclude: ${e.exclude_tag_ids.map(tagLabel).join(", ")}`}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Button size="sm" variant="ghost" onClick={() => edit(e)}>
							Edit
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={action.isPending}
							onClick={() =>
								action.mutate({
									path: `${base}/${e.id}`,
									method: "PUT",
									body: {
										url: e.url,
										events: e.events,
										enabled: !e.enabled,
										include_tag_ids: e.include_tag_ids,
										exclude_tag_ids: e.exclude_tag_ids,
										tag_match: e.tag_match,
									},
								})
							}
						>
							{e.enabled ? "Disable" : "Enable"}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={!e.enabled || action.isPending}
							onClick={() => {
								setHistory(e.id);
								action.mutate({ path: `${base}/${e.id}/test`, method: "POST" });
							}}
						>
							Send test
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setHistory(history === e.id ? "" : e.id)}
						>
							Delivery history
						</Button>
						<Button
							size="sm"
							variant="ghost"
							disabled={action.isPending}
							onClick={() => {
								if (
									window.confirm(
										"Delete this endpoint and its delivery history?",
									)
								)
									action.mutate({ path: `${base}/${e.id}`, method: "DELETE" });
							}}
						>
							Delete
						</Button>
					</div>
					{history === e.id && (
						<div className="grid grid-cols-1 gap-3">
							{deliveries.error && (
								<p role="alert">{deliveries.error.message}</p>
							)}
							{deliveries.data?.length === 0 && (
								<p className="text-sm">No deliveries yet.</p>
							)}
							{deliveries.data?.map((d) => (
								<details key={d.id} className="border-t border-kumo-line pt-2">
									<summary className="cursor-pointer text-sm">
										{d.type} · {d.status}
									</summary>
									<pre className="text-xs whitespace-pre-wrap break-all my-2">
										{JSON.stringify(d.payload, null, 2)}
									</pre>
									{d.history.map((a, i) => (
										<div key={i} className="text-xs my-2">
											Attempt {a.attempt} · {a.status_code ?? a.error} ·{" "}
											{a.duration_ms} ms
											<pre className="whitespace-pre-wrap break-all">
												{a.response}
											</pre>
										</div>
									))}
									{d.status === "failed" && (
										<Button
											size="sm"
											disabled={action.isPending || !e.enabled}
											onClick={() =>
												action.mutate({
													path: `${base}/${e.id}/deliveries/${d.id}/retry`,
													method: "POST",
												})
											}
										>
											Retry
										</Button>
									)}
								</details>
							))}
						</div>
					)}
				</div>
			))}
			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line bg-kumo-tint/40 px-5 py-3 text-xs text-kumo-subtle">
				<span>
					Signed events. Email bodies and attachments are not included.
				</span>
				<a
					href="/api/docs"
					target="_blank"
					rel="noreferrer"
					className="font-medium text-kumo-default hover:underline"
				>
					API documentation ↗
				</a>
			</div>
		</section>
	);
}
