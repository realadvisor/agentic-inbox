import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Email } from "~/types";
import api from "~/services/api";
export function ReplyClassification({
	email,
	mailboxId,
}: {
	email: Email;
	mailboxId: string;
}) {
	const qc = useQueryClient();
	const mutation = useMutation({
		mutationFn: (decision: string | null) =>
			api.setReplyClassification(
				mailboxId,
				email.thread_id!,
				decision,
				email.classification_generation!,
			),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["emails", mailboxId] }),
		onError: () => qc.invalidateQueries({ queryKey: ["emails", mailboxId] }),
	});
	return (
		<span
			className="shrink-0"
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => e.stopPropagation()}
		>
			<select
				aria-label={`Reply status for ${email.subject}`}
				title={`${email.reply_manual ? "Manual: " : "AI suggestion: "}${email.reply_reason ?? "Waiting for background classification. Only active conversations are classified."}`}
				value={email.reply_status ?? "auto"}
				disabled={mutation.isPending}
				onChange={(e) =>
					mutation.mutate(e.target.value === "auto" ? null : e.target.value)
				}
				className={`text-xs rounded border border-kumo-line px-1 py-0.5 max-w-40 bg-kumo-base ${email.reply_status === "reply_needed" ? "text-kumo-warning" : "text-kumo-subtle"}`}
			>
				<option value="auto">
					{email.reply_status ? "Reclassify automatically" : "Not classified"}
				</option>
				<option value="reply_needed">
					Reply needed
					{email.reply_manual && email.reply_status === "reply_needed"
						? " · manual"
						: ""}
				</option>
				<option value="no_reply_needed">
					No reply needed
					{email.reply_manual && email.reply_status === "no_reply_needed"
						? " · manual"
						: ""}
				</option>
				<option value="needs_review">
					Needs review
					{email.reply_manual && email.reply_status === "needs_review"
						? " · manual"
						: ""}
				</option>
			</select>
			{mutation.error && (
				<span role="alert" className="text-xs text-kumo-danger block max-w-48">
					{mutation.error.message}
				</span>
			)}
		</span>
	);
}
