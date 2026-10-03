import { Button, Input, Loader } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { UsersIcon, PlusIcon } from "@phosphor-icons/react";
import { AppSelect } from "./AppSelect";
import { useMailMode } from "./MailMode";

type Role = "admin" | "user";
type Member = { email: string; role: Role };
const roles = [
	{ value: "user", label: "User" },
	{ value: "admin", label: "Admin" },
];
async function request(path = "", method = "GET", body?: unknown) {
	const response = await fetch(`/api/v1/access/members${path}`, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	if (response.status === 204) return;
	const data = await response.json();
	if (!response.ok) throw new Error(data.error ?? "Could not update access");
	return data;
}
export default function AccessSettings() {
	const mode = useMailMode();
	const managed = mode.data?.access?.managed;
	const admin = mode.data?.access?.role === "admin";
	const qc = useQueryClient();
	const [adding, setAdding] = useState(false);
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<Role>("user");
	const members = useQuery<{ members: Member[] }>({
		queryKey: ["inbox-members"],
		queryFn: () => request(),
		enabled: !!managed,
	});
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
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["inbox-members"] });
			await qc.invalidateQueries({ queryKey: ["mail-mode"] });
		},
	});
	const valid = /^[^\s@]+@realadvisor\.com$/i.test(email.trim());
	return (
		<section className="rounded-xl border border-kumo-line bg-kumo-base overflow-hidden">
			<div className="flex flex-wrap items-center justify-between gap-3 p-5">
				<div className="flex items-center gap-3">
					<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-kumo-tint text-kumo-subtle">
						<UsersIcon size={21} />
					</div>
					<div>
						<h2 className="text-sm font-semibold">People with access</h2>
						<p className="mt-0.5 text-xs text-kumo-subtle">
							Manage access to all inbox mailboxes.
						</p>
					</div>
				</div>
				{managed && admin && (
					<Button
						size="sm"
						variant="primary"
						icon={<PlusIcon size={14} />}
						disabled={adding}
						onClick={() => {
							setAdding(true);
							change.reset();
						}}
					>
						Add person
					</Button>
				)}
			</div>
			{!managed ? (
				<p className="p-5 text-sm text-kumo-subtle">
					Member management is not enabled in this environment. Existing access
					is still controlled by Cloudflare Access.
				</p>
			) : (
				<>
					{(change.error || members.error) && (
						<p className="px-5 pt-4 text-sm text-kumo-danger" role="alert">
							{(change.error || members.error)?.message}
						</p>
					)}
					{admin && adding && (
						<form
							className="p-5 border-t border-kumo-line bg-kumo-tint/30 space-y-3"
							onSubmit={async (e) => {
								e.preventDefault();
								try {
									await change.mutateAsync({
										path: "",
										method: "POST",
										body: { email: email.trim(), role },
									});
									setEmail("");
									setRole("user");
									setAdding(false);
								} catch {
									/* The mutation displays the error. */
								}
							}}
						>
							<label
								className="block text-sm font-medium"
								htmlFor="member-email"
							>
								Add a person
							</label>
							<div className="flex flex-col sm:flex-row gap-2 sm:items-center">
								<div className="flex-1 min-w-0 [&_input]:w-full [&>div]:w-full">
									<Input
										autoFocus
										id="member-email"
										type="email"
										aria-label="Email address"
										placeholder="name@realadvisor.com"
										value={email}
										onChange={(e) => setEmail(e.target.value)}
										required
									/>
								</div>
								<AppSelect
									inline
									label="New member role"
									value={role}
									options={roles}
									onChange={(value) => setRole(value as Role)}
									disabled={change.isPending}
								/>
								<Button
									size="base"
									type="submit"
									variant="primary"
									disabled={!valid || change.isPending}
								>
									Add person
								</Button>
								<Button
									type="button"
									size="base"
									variant="ghost"
									disabled={change.isPending}
									onClick={() => {
										setAdding(false);
										change.reset();
									}}
								>
									Cancel
								</Button>
							</div>
							<p className="text-xs text-kumo-subtle">
								Only @realadvisor.com addresses. They sign in with that email;
								no invitation email is sent.
							</p>
							{mode.data?.mode !== "live" && (
								<p className="text-xs text-kumo-subtle">
									Local preview only. Changes here do not grant production
									access.
								</p>
							)}
						</form>
					)}
					{members.isPending ? (
						<div className="p-5">
							<Loader />
						</div>
					) : (
						<ul className="divide-y divide-kumo-line border-t border-kumo-line">
							{members.data?.members.map((member) => (
								<li
									key={member.email}
									className="flex flex-wrap items-center gap-3 px-5 py-3"
								>
									<span className="flex-1 min-w-0 break-all text-sm">
										{member.email}
									</span>
									{admin ? (
										<>
											<AppSelect
												label={`Role for ${member.email}`}
												value={member.role}
												options={roles}
												compact
												disabled={change.isPending}
												onChange={(value) =>
													change.mutate({
														path: `/${encodeURIComponent(member.email)}`,
														method: "PUT",
														body: { role: value },
													})
												}
											/>
											<Button
												size="sm"
												variant="ghost"
												disabled={change.isPending}
												onClick={() => {
													if (
														window.confirm(
															`Remove ${member.email} from all inbox mailboxes?`,
														)
													)
														change.mutate({
															path: `/${encodeURIComponent(member.email)}`,
															method: "DELETE",
														});
												}}
											>
												Remove
											</Button>
										</>
									) : (
										<span className="text-sm text-kumo-subtle">
											{member.role === "admin" ? "Admin" : "User"}
										</span>
									)}
								</li>
							))}
						</ul>
					)}
					{members.data?.members.length === 0 && (
						<p className="p-5 text-sm text-kumo-subtle">
							No people added yet. Add an admin first.
						</p>
					)}
				</>
			)}
			<div className="border-t border-kumo-line bg-kumo-tint/40 px-5 py-3 text-xs text-kumo-subtle">
				Users manage mail and conversations. Admins also manage people,
				mailboxes and settings.
			</div>
		</section>
	);
}
