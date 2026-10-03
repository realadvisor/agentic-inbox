import { Button, Checkbox, Input, Loader } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { KeyIcon, PlusIcon, CopyIcon, CheckIcon } from "@phosphor-icons/react";
import { useMailboxes } from "~/queries/mailboxes";

type Key = {
	id: string;
	name: string;
	prefix: string;
	mailbox_ids: string[];
	permissions: string[];
	created_at: string;
	expires_at: string | null;
	last_used_at: string | null;
	request_count: string;
	revoked_at: string | null;
};
const permissions = [
	{
		id: "mail:read",
		name: "Read mail",
		description: "Read conversations, emails, attachments and tags.",
	},
	{
		id: "drafts:manage",
		name: "Manage drafts",
		description: "Create, edit and delete drafts.",
	},
	{
		id: "mail:send",
		name: "Send email",
		description: "Send new emails, replies and forwards.",
	},
	{
		id: "conversations:manage",
		name: "Manage conversations",
		description: "Update tags, folders, read status and workflow status.",
	},
	{
		id: "webhooks:manage",
		name: "Manage webhooks",
		description: "Create and manage webhooks owned by this key.",
	},
];
async function request(path = "", method = "GET", body?: unknown) {
	const response = await fetch(`/api/v1/api-keys${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (response.status === 204) return;
	const data = await response.json();
	if (!response.ok) throw new Error(data.error ?? "Could not update API keys");
	return data;
}
export default function ApiKeySettings({ mailboxId }: { mailboxId: string }) {
	const qc = useQueryClient(),
		mailboxes = useMailboxes();
	const list = useQuery<Key[]>({
		queryKey: ["api-keys"],
		queryFn: () => request(),
		refetchInterval: 30_000,
	});
	const [adding, setAdding] = useState(false),
		[name, setName] = useState(""),
		[boxes, setBoxes] = useState<string[]>([mailboxId]),
		[scopes, setScopes] = useState<string[]>(["mail:read"]),
		[expiry, setExpiry] = useState(""),
		[secret, setSecret] = useState(""),
		[copied, setCopied] = useState(false),
		[copyError, setCopyError] = useState("");
	const change = useMutation({
		mutationFn: ({
			path,
			method,
			body,
		}: {
			path: string;
			method: string;
			body?: unknown;
		}) => request(path, method, body),
		onSuccess: async (data) => {
			if (data?.key) {
				setSecret(data.key);
				setAdding(false);
			}
			await qc.invalidateQueries({ queryKey: ["api-keys"] });
		},
	});
	return (
		<section
			className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base"
			aria-labelledby="api-keys-heading"
		>
			<div className="flex flex-wrap items-center justify-between gap-3 p-5">
				<div className="flex items-center gap-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle">
						<KeyIcon size={21} />
					</div>
					<div>
						<h2 id="api-keys-heading" className="text-sm font-semibold">
							API keys
						</h2>
						<p className="mt-0.5 text-xs text-kumo-subtle">
							Connect your agents and automations to the inbox.
						</p>
					</div>
				</div>
				<Button
					variant="primary"
					size="sm"
					icon={<PlusIcon size={14} />}
					disabled={adding || !!secret}
					onClick={() => {
						setName("");
						setBoxes([mailboxId]);
						setScopes(["mail:read"]);
						setExpiry("");
						setCopied(false);
						setCopyError("");
						setAdding(true);
						change.reset();
					}}
				>
					Create key
				</Button>
			</div>
			{(list.error || change.error) && (
				<p role="alert" className="px-5 py-3 text-sm text-kumo-danger">
					{(list.error || change.error)?.message}
				</p>
			)}
			{secret && (
				<div className="space-y-3 border-t border-kumo-line bg-kumo-tint/40 p-5">
					<div>
						<h3 className="text-sm font-medium">Your key is ready</h3>
						<p className="mt-1 text-xs text-kumo-subtle">
							Copy it now and store it somewhere safe. You won’t be able to see
							it again.
						</p>
					</div>
					<div className="flex items-center gap-3 rounded-lg border border-kumo-line bg-kumo-base p-3">
						<code className="min-w-0 flex-1 break-all text-xs select-all">
							{secret}
						</code>
						<Button
							size="sm"
							variant="secondary"
							icon={copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(secret);
									setCopied(true);
									setCopyError("");
								} catch {
									setCopyError(
										"Could not copy. Select the key above and copy it manually.",
									);
								}
							}}
						>
							{copied ? "Copied" : "Copy key"}
						</Button>
					</div>
					{copyError && (
						<p role="alert" className="text-xs text-kumo-danger">
							{copyError}
						</p>
					)}
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-xs text-kumo-subtle">
							Use as a Bearer token in the Authorization header.
						</p>
						<Button size="sm" variant="secondary" onClick={() => setSecret("")}>
							Done
						</Button>
					</div>
				</div>
			)}
			{adding && (
				<form
					className="border-t border-kumo-line bg-kumo-tint/30 p-5 space-y-5"
					onSubmit={async (e) => {
						e.preventDefault();
						await change
							.mutateAsync({
								path: "",
								method: "POST",
								body: {
									name,
									mailbox_ids: boxes,
									permissions: scopes,
									expires_at: expiry
										? new Date(`${expiry}T23:59:59Z`).toISOString()
										: null,
								},
							})
							.catch(() => {});
					}}
				>
					<h3 className="text-sm font-semibold">Create an API key</h3>
					<div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
						<Input
							autoFocus
							label="Name"
							placeholder="n8n Privacy"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
							maxLength={80}
						/>
						<Input
							label="Expiry (optional)"
							type="date"
							value={expiry}
							onChange={(e) => setExpiry(e.target.value)}
						/>
					</div>
					<fieldset className="min-w-0">
						<legend className="text-sm font-medium mb-2">
							Allowed mailboxes
						</legend>
						<div className="max-h-40 overflow-y-auto rounded-lg border border-kumo-line bg-kumo-base p-3 space-y-3">
							{mailboxes.isLoading ? (
								<Loader />
							) : mailboxes.error ? (
								<p role="alert">Could not load mailboxes.</p>
							) : (
								mailboxes.data?.map((box) => (
									<Checkbox
										key={box.id}
										label={box.id}
										checked={boxes.includes(box.id)}
										onCheckedChange={(value) =>
											setBoxes((prev) =>
												value
													? [...prev, box.id]
													: prev.filter((id) => id !== box.id),
											)
										}
									/>
								))
							)}
						</div>
					</fieldset>
					<fieldset>
						<legend className="mb-2 text-sm font-medium">Permissions</legend>
						<div className="grid gap-2 sm:grid-cols-2">
							{permissions.map((scope) => (
								<div
									key={scope.id}
									className="rounded-lg border border-kumo-line bg-kumo-base p-3"
								>
									<Checkbox
										label={scope.name}
										checked={scopes.includes(scope.id)}
										onCheckedChange={(value) =>
											setScopes((prev) =>
												value
													? [...prev, scope.id]
													: prev.filter((id) => id !== scope.id),
											)
										}
									/>
									<p className="text-xs text-kumo-subtle ml-6 mt-1">
										{scope.description}
									</p>
								</div>
							))}
						</div>
					</fieldset>

					<div className="flex justify-end gap-2 border-t border-kumo-line pt-4">
						<Button
							type="button"
							variant="ghost"
							disabled={change.isPending}
							onClick={() => {
								setAdding(false);
								change.reset();
							}}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							variant="primary"
							disabled={
								change.isPending ||
								!name.trim() ||
								!boxes.length ||
								!scopes.length ||
								!!mailboxes.error ||
								mailboxes.isLoading
							}
						>
							{change.isPending ? "Creating…" : "Create key"}
						</Button>
					</div>
				</form>
			)}
			{list.isLoading ? (
				<div className="flex justify-center border-t border-kumo-line p-10">
					<Loader />
				</div>
			) : list.data?.length === 0 ? (
				<div className="border-t border-kumo-line px-5 py-12 text-center">
					<KeyIcon size={28} className="mx-auto mb-3 text-kumo-subtle" />
					<p className="text-sm font-medium">No API keys yet</p>
					<p className="mt-1 text-xs text-kumo-subtle">
						Create a key to connect n8n or your AI agent.
					</p>
				</div>
			) : (
				<div className="border-t border-kumo-line">
					<ul className="divide-y divide-kumo-line">
						{list.data?.map((key) => {
							const inactive =
								!!key.revoked_at ||
								(!!key.expires_at && Date.parse(key.expires_at) <= Date.now());
							return (
								<li
									key={key.id}
									className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 px-5 py-3"
								>
									<div className="min-w-0 space-y-1.5">
										<div className="flex flex-wrap items-center gap-2">
											<span className="break-words text-sm font-medium">
												{key.name}
											</span>
											<span className="inline-flex items-center gap-1.5 rounded-md bg-kumo-tint px-1.5 py-0.5 text-[11px] text-kumo-subtle">
												<span
													className={`h-1.5 w-1.5 rounded-full ${inactive ? "bg-kumo-subtle" : "bg-emerald-500"}`}
												/>
												{key.revoked_at
													? "Revoked"
													: inactive
														? "Expired"
														: "Active"}
											</span>

											<code className="text-[11px] text-kumo-subtle">
												{key.prefix}••••••••
											</code>
										</div>
										<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
											<p className="break-all text-xs text-kumo-subtle">
												{key.mailbox_ids.join(", ")}
											</p>
											<div className="flex flex-wrap gap-1.5">
												{permissions
													.filter((p) => key.permissions.includes(p.id))
													.map((p) => (
														<span
															key={p.id}
															className="rounded bg-kumo-tint px-1.5 py-0.5 text-[11px] text-kumo-subtle"
														>
															{p.name}
														</span>
													))}
											</div>
										</div>
									</div>
									<div className="col-span-2 row-start-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-kumo-subtle [&>p+p]:before:content-['·'] [&>p+p]:before:mr-2">
										<p className="text-kumo-default tabular-nums">
											{Number(key.request_count).toLocaleString()} requests
										</p>
										<p
											title={
												key.last_used_at
													? new Date(key.last_used_at).toLocaleString()
													: undefined
											}
										>
											{key.last_used_at
												? `Last used ${new Date(key.last_used_at).toLocaleDateString()}`
												: "Not used yet"}
										</p>
										<p>
											{key.expires_at
												? `Expires ${new Date(key.expires_at).toLocaleDateString()}`
												: "No expiry"}
										</p>
									</div>
									<div className="col-start-2 row-start-1 justify-self-end">
										{!key.revoked_at && (
											<Button
												size="sm"
												variant="ghost"
												disabled={change.isPending}
												onClick={() => {
													if (
														window.confirm(
															`Revoke ${key.name}? Requests using this key will stop working. Existing webhooks remain active.`,
														)
													)
														change.mutate({
															path: `/${key.id}`,
															method: "DELETE",
														});
												}}
											>
												Revoke
											</Button>
										)}
									</div>
								</li>
							);
						})}
					</ul>
				</div>
			)}
			<div className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line bg-kumo-tint/40 px-5 py-3 text-xs text-kumo-subtle">
				<span>
					Each key only has access to its selected mailboxes and permissions.
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
