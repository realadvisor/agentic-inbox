import type { Database } from "./db";
import type { RecipientSuggestion } from "../shared/contacts";

export async function recipientSuggestions(
	db: Database,
	mailbox: string,
	query: string,
	excluded: string[] = [],
): Promise<RecipientSuggestion[]> {
	const search = query.trim().toLowerCase();
	if (search.length < 2 || search.length > 100) return [];
	const prefix = search.replace(/[\\%_]/g, "\\$&") + "%";
	return db<RecipientSuggestion[]>`
		SELECT email, name FROM mailbox_contacts
		WHERE mailbox_id=${mailbox}
		  AND (email LIKE ${prefix} OR lower(name) LIKE ${prefix})
		  AND NOT (email = ANY(${excluded.map((s) => s.toLowerCase())}::text[]))
		ORDER BY (email=${search}) DESC, sent_count DESC, last_used_at DESC, email
		LIMIT 5`;
}
