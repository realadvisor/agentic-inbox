import { Navigate, useParams, useSearchParams } from "react-router";

// Preserve existing bookmarked run and conversation URLs.
export default function ClassifierRunsRedirect() {
	const { mailboxId } = useParams();
	const [params] = useSearchParams();
	const next = new URLSearchParams(params);
	next.set("tab", "runs");
	return (
		<Navigate
			replace
			to={`/mailbox/${encodeURIComponent(mailboxId ?? "")}/settings?${next}`}
		/>
	);
}
