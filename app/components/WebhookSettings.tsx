import { AppSelect } from "./AppSelect";
import { useTags } from "~/queries/tags";
import { Button, Input, Checkbox } from "@cloudflare/kumo";
import { useState } from "react";
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
	"conversation.matched",
	"email.received",
	"email.sent",
	"conversation.tags_changed",
	"conversation.classified",
	"conversation.status_changed",
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
		[selected, setSelected] = useState<string[]>(["conversation.matched"]),
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
		setSelected(e?.events ?? ["conversation.matched"]);
		setIncluded(e?.include_tag_ids ?? []);
		setExcluded(e?.exclude_tag_ids ?? []);
		setMatch(e?.tag_match ?? "any");
		setSecret("");
	};
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<div>
					<h2 className="font-semibold">Webhooks</h2>
					<p className="text-sm text-kumo-subtle">
						Send signed events from this mailbox to your integrations.
					</p>
				</div>
				<Button onClick={() => edit(null)}>Add endpoint</Button>
			</div>
			{(action.error || list.error) && (
				<p role="alert" className="text-kumo-danger">
					{(action.error || list.error)?.message}
				</p>
			)}
			{secret && (
				<div className="rounded-lg border border-kumo-line p-4">
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
					className="rounded-lg border border-kumo-line bg-kumo-base p-4 space-y-3"
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
						{selected.includes("conversation.matched") && (
							<p className="text-xs text-kumo-subtle">
								Tag conditions matched fires when a conversation starts meeting
								the conditions below, including after Jev adds tags.
							</p>
						)}
					</fieldset>
					<section
						aria-label="Tag conditions"
						className="rounded-lg border border-kumo-line"
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
					<p className="text-xs text-kumo-subtle">
						Email bodies and attachments are not included.
					</p>
					<div className="flex gap-2">
						<Button
							type="submit"
							variant="primary"
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
							onClick={() => setEditing(undefined)}
						>
							Cancel
						</Button>
					</div>
				</form>
			)}
			{list.data?.length === 0 && (
				<p className="text-sm text-kumo-subtle">
					No endpoints yet. Add a URL, choose when to send, then send a test.
				</p>
			)}
			{list.data?.map((e) => (
				<div
					key={e.id}
					className="rounded-lg border border-kumo-line bg-kumo-base p-5 space-y-3"
				>
					<div className="font-medium break-all">{e.url}</div>
					<p className="text-xs text-kumo-subtle">
						{e.enabled ? "Enabled" : "Disabled"} ·{" "}
						{e.events.map((event) => eventLabels[event] ?? event).join(", ")}
					</p>
					{(e.include_tag_ids.length > 0 || e.exclude_tag_ids.length > 0) && (
						<p className="text-sm text-kumo-subtle">
							{e.include_tag_ids.length > 0 &&
								`Match ${e.tag_match}: ${e.include_tag_ids.map(tagLabel).join(", ")}`}
							{e.exclude_tag_ids.length > 0 &&
								` · Exclude: ${e.exclude_tag_ids.map(tagLabel).join(", ")}`}
						</p>
					)}
					<div className="flex flex-wrap gap-2">
						<Button size="sm" onClick={() => edit(e)}>
							Edit
						</Button>
						<Button
							size="sm"
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
		</div>
	);
}
