import EmailIframe from "./EmailIframe";
import { useEmail } from "~/queries/emails";
import { rewriteInlineImages } from "~/lib/utils";

export default function ForwardedMessage({
	html,
	mailboxId,
	sourceId,
}: {
	html: string;
	mailboxId?: string;
	sourceId?: string;
}) {
	const { data: source } = useEmail(mailboxId, sourceId);
	const preview =
		mailboxId && sourceId
			? rewriteInlineImages(html, mailboxId, sourceId, source?.attachments)
			: html;
	return (
		<details className="mx-5 mb-4 text-xs text-kumo-subtle" open>
			<summary className="cursor-pointer py-2">Forwarded message</summary>
			<div
				className="h-80 overflow-hidden rounded border border-kumo-line"
				aria-label="Forwarded message preview"
			>
				<EmailIframe body={preview} />
			</div>
		</details>
	);
}
