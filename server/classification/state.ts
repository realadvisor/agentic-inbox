import type { Database } from "../db";
import { liveSender } from "../mailboxes";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
export function readableText(html: string) {
	function visit(node: DefaultTreeAdapterMap["node"]): string {
		if (node.nodeName === "#text")
			return (node as DefaultTreeAdapterMap["textNode"]).value;
		if (!("childNodes" in node)) return "";
		if (["script", "style", "template", "head"].includes(node.nodeName))
			return "";
		if (node.nodeName === "br") return "\n";
		const text = node.childNodes.map(visit).join("");
		return ["p", "div", "li", "tr", "blockquote"].includes(node.nodeName)
			? `\n${text}\n`
			: node.nodeName === "td"
				? `${text} `
				: text;
	}
	return visit(parseFragment(html))
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
export class ConversationSizeError extends Error {
	constructor() {
		super("Conversation is too large to process safely.");
	}
}
export async function conversationState(
	db: Database,
	mailbox: string,
	thread: string,
	evaluatedAt = new Date(),
) {
	const [size] =
		await db`SELECT count(*)::int AS count,coalesce(sum(length(body)+length(subject)),0)::int AS chars FROM emails WHERE mailbox_id=${mailbox} AND thread_id=${thread} AND delivery_status IN ('received','sent')`;
	if (size.count > 1000 || size.chars > 10_000_000)
		throw new ConversationSizeError();
	const rows = await db<
		{
			from: string;
			to: string;
			cc: string;
			subject: string;
			body_html: string;
			date: Date;
			direction: string;
			attachment_count: number;
		}[]
	>`SELECT sender AS "from",recipient AS "to",cc,subject,body AS body_html,date,CASE WHEN delivery_status='sent' THEN 'outbound' ELSE 'inbound' END AS direction,(SELECT count(*)::int FROM attachments a WHERE a.email_id=e.id AND a.mailbox_id=e.mailbox_id) AS attachment_count FROM emails e WHERE mailbox_id=${mailbox} AND thread_id=${thread} AND delivery_status IN ('received','sent') ORDER BY date,id`;
	const seen = new Set<string>();
	const messages = rows.map(({ body_html, ...row }) => {
		const lines = readableText(body_html).split("\n");
		const kept = lines.filter(
			(line) =>
				!(
					line.trim().startsWith(">") &&
					seen.has(line.trim().replace(/^>\s*/, ""))
				),
		);
		lines.forEach((line) => {
			if (line.trim()) seen.add(line.trim().replace(/^>\s*/, ""));
		});
		return {
			...row,
			date: row.date.toISOString(),
			text: kept.join("\n"),
			duplicate_quoted_lines_removed: lines.length - kept.length,
		};
	});
	return {
		our_mailbox: liveSender(mailbox) ?? mailbox,
		evaluated_at: evaluatedAt.toISOString(),
		timezone: "UTC",
		messages,
	};
}
