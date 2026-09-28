import { readFile, writeFile, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { dirname, join, resolve } from "node:path";
import PostalMime from "postal-mime";
import postgres from "postgres";
const { values } = parseArgs({ options: { index: { type: "string" } } });
if (!values.index) throw Error("--index is required");
const indexPath = resolve(values.index),
	base = dirname(indexPath);
const input = JSON.parse(await readFile(indexPath, "utf8"));
if (!["privacy", "info"].includes(input.name))
	throw Error("Unsupported mailbox");
const db = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
try {
	for (const name of [input.name]) {
		const index = input;
		const mailbox = name + "@ingest.realadvisor.com";
		const existing =
			await db`SELECT id,message_id,thread_id,folder_id,read,starred FROM emails WHERE mailbox_id=${mailbox}`;
		await writeFile(
			join(base, name + "-existing.json"),
			JSON.stringify(existing),
			{ mode: 0o600 },
		);
		const known = new Set(existing.map((x) => x.message_id));
		const seen = new Set();
		const source = await open(index.path, "r");
		const rows = [];
		let bytes = 0,
			attachments = 0,
			duplicate = 0,
			invalid = 0;
		for (const r of index.messages) {
			let raw = Buffer.alloc(r.bytes);
			await source.read(raw, 0, r.bytes, r.start);
			const hash = createHash("sha256").update(raw).digest("hex");
			try {
				if (r.bytes > 50 * 1024 * 1024) throw Error("exceeds_50_MiB");
				const p = await PostalMime.parse(raw, {
					maxNestingDepth: 30,
					maxHeadersSize: 256000,
				});
				const confirmed =
					r.verified ||
					(p.to ?? []).some(
						(x) => x.address?.toLowerCase() === name + "@realadvisor.com",
					);
				if (!confirmed) throw Error("group_identity_unverified");
				const date = Date.parse(p.date ?? "");
				if (!Number.isFinite(date)) throw Error("invalid_date");
				const messageId = p.messageId ?? `<${hash}@ingest.realadvisor.com>`;
				const dup = known.has(messageId) || seen.has(messageId);
				seen.add(messageId);
				if (dup) duplicate++;
				const row = {
					...r,
					hash,
					messageId,
					date: new Date(date).toISOString(),
					duplicate: dup,
					attachments: p.attachments.length,
					attachmentBytes: p.attachments.reduce(
						(a, x) =>
							a +
							(typeof x.content === "string"
								? Buffer.byteLength(x.content)
								: x.content.byteLength),
						0,
					),
					folder:
						p.from?.address?.toLowerCase() === name + "@realadvisor.com"
							? "sent"
							: "archive",
					refs: [
						p.inReplyTo,
						...(p.references?.match(/<[^>]+>/g) ?? []),
					].filter(Boolean),
				};
				rows.push(row);
				bytes += row.attachmentBytes;
				attachments += row.attachments;
			} catch (e) {
				invalid++;
				rows.push({
					...r,
					hash,
					error: e instanceof Error ? e.message : "parse_failed",
				});
			}
			if (rows.length % 5000 === 0)
				console.log(JSON.stringify({ name, scanned: rows.length }));
		}
		await source.close();
		const dates = rows
			.filter((x) => x.date)
			.map((x) => x.date)
			.sort();
		const summary = {
			name,
			total: rows.length,
			eligible: rows.length - invalid,
			duplicates: duplicate,
			toInsert: rows.length - invalid - duplicate,
			invalid,
			attachments,
			attachmentBytes: bytes,
			from: dates[0],
			to: dates.at(-1),
			sent: rows.filter((x) => x.folder === "sent").length,
			errors: rows
				.filter((x) => x.error)
				.map((x) => ({ index: x.index, bytes: x.bytes, error: x.error })),
		};
		await writeFile(
			join(base, name + "-plan.json"),
			JSON.stringify({ ...index, messages: rows, summary }),
			{ mode: 0o600 },
		);
		console.log(JSON.stringify(summary));
	}
} finally {
	await db.end();
}
