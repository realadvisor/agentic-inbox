import { Button, Checkbox, Input, Loader } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
		[secret, setSecret] = useState("");
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
		<section className="space-y-4">
			<div className="flex items-start justify-between gap-3">
				<div>
					<h2 className="font-semibold">API keys</h2>
					<p className="text-sm text-kumo-subtle">
						Connect an agent or n8n to your inbox.
					</p>
				</div>
				<Button
					onClick={() => {
						setName("");
						setBoxes([mailboxId]);
						setScopes(["mail:read"]);
						setExpiry("");
						setSecret("");
						setAdding(true);
						change.reset();
					}}
				>
					Create key
				</Button>
			</div>
			{(list.error || change.error) && (
				<p role="alert" className="text-sm text-kumo-danger">
					{(list.error || change.error)?.message}
				</p>
			)}
			{secret && (
				<div className="rounded-lg border border-kumo-line p-4 space-y-3">
					<p className="text-sm font-medium">
						Copy your key now. It won’t be shown again.
					</p>
					<code className="block break-all text-xs select-all">{secret}</code>
					<p className="text-xs text-kumo-subtle">
						Use it as a Bearer token in the Authorization header. No Cloudflare
						service token is needed once API key access is enabled.
					</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							onClick={() => navigator.clipboard.writeText(secret)}
						>
							Copy key
						</Button>
						<Button size="sm" variant="ghost" onClick={() => setSecret("")}>
							Done
						</Button>
					</div>
				</div>
			)}
			{adding && (
				<form
					className="rounded-lg border border-kumo-line bg-kumo-base p-4 space-y-4"
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
					<Input
						label="Key name"
						placeholder="n8n Privacy"
						value={name}
						onChange={(e) => setName(e.target.value)}
						required
						maxLength={80}
					/>
					<fieldset className="space-y-2">
						<legend className="text-sm font-medium mb-2">
							Allowed mailboxes
						</legend>
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
					</fieldset>
					<fieldset className="space-y-3 border-t border-kumo-line pt-3">
						<legend className="text-sm font-medium">Permissions</legend>
						{permissions.map((scope) => (
							<div key={scope.id}>
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
					</fieldset>
					<Input
						label="Expires on (optional)"
						type="date"
						value={expiry}
						onChange={(e) => setExpiry(e.target.value)}
					/>
					<div className="flex gap-2">
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
							Generate key
						</Button>
						<Button
							type="button"
							variant="ghost"
							onClick={() => setAdding(false)}
						>
							Cancel
						</Button>
					</div>
				</form>
			)}
			{list.isLoading ? (
				<Loader />
			) : list.data?.length === 0 ? (
				<p className="text-sm text-kumo-subtle">No API keys yet.</p>
			) : (
				<div className="divide-y divide-kumo-line rounded-lg border border-kumo-line">
					{list.data?.map((key) => {
						const inactive =
							!!key.revoked_at ||
							(!!key.expires_at && Date.parse(key.expires_at) <= Date.now());
						return (
							<div key={key.id} className="p-4 space-y-2">
								<div className="flex items-center justify-between gap-3">
									<div>
										<span className="text-sm font-medium">{key.name}</span>
										<span className="ml-2 text-xs text-kumo-subtle">
											{key.revoked_at
												? "Revoked"
												: inactive
													? "Expired"
													: "Active"}
										</span>
									</div>
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
								<code className="text-xs text-kumo-subtle">{key.prefix}…</code>
								<p className="text-xs break-words">
									{key.mailbox_ids.join(", ")}
								</p>
								<p className="text-xs text-kumo-subtle">
									{permissions
										.filter((p) => key.permissions.includes(p.id))
										.map((p) => p.name)
										.join(" · ")}
								</p>
								<p className="text-xs text-kumo-subtle">
									{key.last_used_at
										? `Last used ${new Date(key.last_used_at).toLocaleString()}`
										: "Never used"}{" "}
									· {key.request_count} requests
									{key.expires_at
										? ` · Expires ${new Date(key.expires_at).toLocaleDateString()}`
										: ""}
								</p>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
