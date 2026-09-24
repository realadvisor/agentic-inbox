import { useState } from "react";
import { useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { BookmarkSimpleIcon, CircleNotchIcon } from "@phosphor-icons/react";
import { classifierRequest } from "~/services/classifiers";
import type { Tag } from "~/types";

export function ConversationExample({
	mailboxId,
	threadId,
	tags = [],
}: {
	mailboxId: string;
	threadId: string;
	tags?: Tag[];
}) {
	const client = useQueryClient();
	const mutations = useIsMutating();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const queryKey = ["jev-examples", "thread", mailboxId, threadId];
	const path = `/examples/threads/${encodeURIComponent(mailboxId)}/${threadId}`;
	const status = useQuery({
		queryKey,
		queryFn: () => classifierRequest<{ saved: boolean }>(path),
	});
	const isSaved = status.data?.saved === true;
	async function save() {
		setBusy(true);
		setError("");
		try {
			if (isSaved) {
				await classifierRequest(path, "DELETE");
			} else {
				await classifierRequest<{ saved: string[] }>(
					"/examples/from-tags",
					"POST",
					{
						mailbox_id: mailboxId,
						thread_id: threadId,
						tag_ids: tags.map((t) => t.id),
					},
				);
			}
			client.setQueryData(queryKey, { saved: !isSaved });
			await client.invalidateQueries({ queryKey: ["jev-examples"] });
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not update example");
			await client.invalidateQueries({ queryKey: ["emails"] });
		} finally {
			setBusy(false);
		}
	}
	return (
		<>
			<Button
				type="button"
				size="sm"
				variant="ghost"
				disabled={busy || mutations > 0 || !status.isSuccess}
				title={
					isSaved
						? "Remove this conversation from all example sets"
						: "Confirm the current tags as example labels. Unassigned groups are skipped."
				}
				className={
					isSaved ? "text-emerald-700 dark:text-emerald-400" : undefined
				}
				aria-pressed={isSaved}
				aria-live="polite"
				aria-busy={busy}
				onClick={() => void save()}
			>
				{busy ? (
					<CircleNotchIcon
						size={15}
						className="animate-spin"
						aria-hidden="true"
					/>
				) : (
					<BookmarkSimpleIcon
						size={15}
						weight={isSaved ? "fill" : "regular"}
						aria-hidden="true"
					/>
				)}
				{busy
					? isSaved
						? "Removing…"
						: "Saving…"
					: isSaved
						? "Saved as example"
						: "Save as example"}
			</Button>

			{(error || status.isError) && (
				<span role="alert" className="basis-full text-xs text-kumo-danger">
					{error ||
						"Could not load example status. Reopen the conversation to try again."}
				</span>
			)}
		</>
	);
}
