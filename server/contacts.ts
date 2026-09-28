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
	// Access is currently application-wide: authenticated users can read every
	// registered live mailbox. Only All is shared; other mailbox indexes stay scoped.
	// If per-mailbox ACLs are introduced, this source list must use those same ACLs.
	return db<RecipientSuggestion[]>`
		WITH sources AS (
			SELECT ${mailbox}::text AS mailbox_id, true AS local
			UNION ALL
			SELECT id, false FROM mailboxes
			WHERE id='all@ingest.realadvisor.com' AND email=id AND id<>${mailbox}
		), candidates AS (
			SELECT contact.*, sources.local FROM sources
			CROSS JOIN LATERAL (
				SELECT email, name, sent_count, last_used_at FROM mailbox_contacts
				WHERE mailbox_id=sources.mailbox_id
				  AND (email LIKE ${prefix} OR lower(name) LIKE ${prefix})
				  AND NOT (email = ANY(${[
						...excluded.map((s) => s.toLowerCase()),
						mailbox.toLowerCase(),
						mailbox.toLowerCase().replace("@ingest.", "@"),
					]}::text[]))
				ORDER BY (email=${search}) DESC, sent_count DESC, last_used_at DESC, email
				LIMIT 5
			) contact
		), unique_contacts AS (
			SELECT DISTINCT ON (email) * FROM candidates ORDER BY email, local DESC
		)
		SELECT email, name FROM unique_contacts
		ORDER BY local DESC, (email=${search}) DESC, sent_count DESC, last_used_at DESC, email
		LIMIT 5`;
}
