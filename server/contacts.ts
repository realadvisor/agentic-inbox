import type { DirectorySearch } from "./workspace-directory";
import type { Database } from "./db";
import type { RecipientSuggestion } from "../shared/contacts";

async function mailboxSuggestions(
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

export async function recipientSuggestions(
	db: Database,
	mailbox: string,
	query: string,
	excluded: string[] = [],
	directory?: DirectorySearch,
): Promise<RecipientSuggestion[]> {
	const search = query.trim().toLowerCase();
	if (search.length < 2 || search.length > 100) return [];
	const [contacts, people] = await Promise.all([
		mailboxSuggestions(db, mailbox, query, excluded),
		directory ? directory(search).catch(() => []) : Promise.resolve([]),
	]);
	if (!directory) return contacts;
	const blocked = new Set(
		[...excluded, mailbox, mailbox.replace("@ingest.", "@")].map((email) =>
			email.toLowerCase(),
		),
	);
	const directoryByEmail = new Map(
		people.map((person) => [person.email.toLowerCase(), person]),
	);
	// Reserve room for directory matches while retaining familiar recipients first.
	const ordered = [...contacts.slice(0, 3), ...people, ...contacts.slice(3)];
	ordered.sort(
		(a, b) =>
			Number(b.email.toLowerCase() === search) -
			Number(a.email.toLowerCase() === search),
	);
	const results: RecipientSuggestion[] = [];
	for (const contact of ordered) {
		const email = contact.email.toLowerCase();
		if (blocked.has(email)) continue;
		blocked.add(email);
		results.push({
			email,
			name: contact.name || directoryByEmail.get(email)?.name || null,
		});
		if (results.length === 5) break;
	}
	return results;
}
