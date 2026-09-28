import { open, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import PostalMime, { type Address } from "postal-mime";
import postgres from "postgres";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
const { values } = parseArgs({
	options: {
		plan: { type: "string" },
		limit: { type: "string" },
		apply: { type: "boolean", default: false },
	},
});
if (!values.plan) throw Error("--plan is required");
const planFile = resolve(values.plan);
const base = dirname(planFile);
interface PlannedMessage {
	index: number;
	start: number;
	end: number;
	bytes: number;
	verified: boolean;
	hash: string;
	messageId: string;
	date: string;
	duplicate: boolean;
	attachments: number;
	attachmentBytes: number;
	folder: "sent" | "archive";
	refs: string[];
}
interface ImportPlan {
	name: "privacy" | "info";
	path: string;
	messages: PlannedMessage[];
	summary: { invalid: number };
}
const plan = JSON.parse(await readFile(planFile, "utf8")) as ImportPlan;
if (!["privacy", "info"].includes(plan.name) || plan.summary.invalid)
	throw Error("Unvalidated plan");
const mailbox = plan.name + "@ingest.realadvisor.com";
if (
	new URL(process.env.DATABASE_URL!).hostname !==
	"ep-solitary-rice-b1w3x6nu.c-5.eu-central-1.aws.neon.tech"
)
	throw Error("Unexpected production database");
const db = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
const source = await open(plan.path, "r");
let proxy: PlatformProxy<Record<string, unknown>> | undefined;
const uuid = (value: string) => {
	const h = createHash("sha256").update(value).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const addresses = (list: Address[] = []) =>
	list
		.flatMap((a) =>
			a.address ? [a.address] : (a.group?.map((x) => x.address) ?? []),
		)
		.join(", ");
const escape = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "<br>");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function log(record: unknown) {
	const f = await open(join(base, plan.name + "-import.ndjson"), "a", 0o600);
	try {
		await f.write(JSON.stringify(record) + "\n");
		await f.sync();
	} finally {
		await f.close();
	}
}
async function pool<T>(items: T[], fn: (x: T) => Promise<void>, workers = 8) {
	let cursor = 0;
	let failure: unknown;
	await Promise.all(
		Array.from({ length: Math.min(workers, items.length) }, async () => {
			while (cursor < items.length && !failure) {
				const n = cursor++;
				try {
					await fn(items[n]);
				} catch (error) {
					failure = error;
				}
			}
		}),
	);
	if (failure) throw failure;
}
try {
	const guard =
		await db`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname IN ('classifier_email_changed','enqueue_agent_draft','inbox_message_thread','emit_inbox_webhook') AND position('inbox.historical_import' in pg_get_functiondef(p.oid))>0`;
	if (values.apply && guard.length !== 4)
		throw Error("Historical import guard missing");
	const existing =
		await db`SELECT id,message_id,thread_id,in_reply_to,email_references,date FROM emails WHERE mailbox_id=${mailbox} ORDER BY date,id`;
	const existingById = new Map(existing.map((r) => [r.message_id, r]));
	// Reply/reference components include missing historical parents, never subjects.
	const parents = new Map<string, string>();
	const root = (key: string): string => {
		if (!parents.has(key)) parents.set(key, key);
		let r = key;
		while (parents.get(r) !== r) r = parents.get(r)!;
		while (key !== r) {
			const next = parents.get(key)!;
			parents.set(key, r);
			key = next;
		}
		return r;
	};
	const union = (a: string, b: string) => {
		const x = root(a),
			y = root(b);
		if (x !== y) parents.set(y, x);
	};
	for (const r of plan.messages) {
		root(r.messageId);
		for (const ref of r.refs) union(r.messageId, ref);
	}
	for (const r of existing) {
		root(r.message_id);
		for (const ref of [
			r.in_reply_to,
			...(r.email_references?.match(/<[^>]+>/g) ?? []),
		].filter(Boolean))
			union(r.message_id, ref);
	}
	const threads = new Map<string, string>(),
		conflicts = new Set<string>();
	for (const r of existing) {
		const key = root(r.message_id);
		if (threads.has(key) && threads.get(key) !== r.thread_id)
			conflicts.add(key);
		else threads.set(key, r.thread_id);
	}
	const seen = new Set<string>();
	const candidates = plan.messages
		.filter((r: PlannedMessage) => {
			if (seen.has(r.messageId) || existingById.has(r.messageId)) return false;
			seen.add(r.messageId);
			return true;
		})
		.sort(
			(a: PlannedMessage, b: PlannedMessage) =>
				a.date.localeCompare(b.date) || a.index - b.index,
		);
	for (const r of candidates) {
		const key = root(r.messageId);
		if (!threads.has(key)) threads.set(key, uuid(mailbox + ":thread:" + key));
	}
	const maximum = values.limit ? Number(values.limit) : candidates.length;
	if (!Number.isSafeInteger(maximum) || maximum < 0)
		throw Error("Invalid limit");
	const selected = candidates.slice(0, maximum);
	console.log(
		JSON.stringify({
			mailbox,
			mode: values.apply ? "apply" : "plan",
			sourceMessages: plan.messages.length,
			existingOrRepeated: plan.messages.length - candidates.length,
			remaining: candidates.length,
			selected: selected.length,
			existingThreadConflicts: conflicts.size,
		}),
	);
	if (conflicts.size)
		throw Error("Review existing thread conflicts before importing");
	if (!values.apply) process.exitCode = 0;
	else {
		proxy = await getPlatformProxy({
			configPath: ".local/r2.json",
			persist: false,
			envFiles: [],
		});
		const bucket = proxy.env.ATTACHMENTS as {
			put: (k: string, b: Uint8Array) => Promise<unknown>;
			head: (k: string) => Promise<{ size: number } | null>;
		};
		const put = async (key: string, bytes: Uint8Array) => {
			for (let attempt = 0; ; attempt++) {
				try {
					await bucket.put(key, bytes);
					return;
				} catch {
					if (attempt === 3) throw Error("R2 upload failed");
					await sleep(500 * 2 ** attempt);
				}
			}
		};
		let insertedTotal = 0,
			skippedTotal = 0;
		for (let offset = 0; offset < selected.length; offset += 100) {
			const chunk = selected.slice(offset, offset + 100);
			const prepared: {
				index: number;
				hash: string;
				record: {
					id: string;
					mailbox_id: string;
					folder_id: string;
					subject: string;
					sender: string;
					recipient: string;
					cc: string;
					bcc: string;
					date: Date;
					read: boolean;
					starred: boolean;
					body: string;
					in_reply_to: string | null;
					email_references: string | null;
					thread_id: string;
					message_id: string;
					raw_storage_key: string;
					reply_to: string | null;
					delivery_status: string;
				};
				attachments: {
					id: string;
					mailbox_id: string;
					email_id: string;
					filename: string;
					mimetype: string;
					size: number;
					storage_key: string;
				}[];
			}[] = [];
			await pool(chunk, async (r: PlannedMessage) => {
				const raw = Buffer.alloc(r.bytes);
				const { bytesRead } = await source.read(raw, 0, r.bytes, r.start);
				if (
					bytesRead !== r.bytes ||
					createHash("sha256").update(raw).digest("hex") !== r.hash
				)
					throw Error("Source changed after dry run");
				const p = await PostalMime.parse(raw, {
					maxNestingDepth: 30,
					maxHeadersSize: 256000,
				});
				const id = uuid(mailbox + ":email:" + r.messageId),
					rawKey = `raw/${mailbox}/${r.hash}.eml`;
				const record = {
					id,
					mailbox_id: mailbox,
					folder_id: r.folder,
					subject: p.subject ?? "",
					sender: addresses(p.from ? [p.from] : []),
					recipient: addresses(p.to) || mailbox,
					cc: addresses(p.cc),
					bcc: addresses(p.bcc),
					date: new Date(r.date),
					read: true,
					starred: false,
					body: p.html ?? escape(p.text ?? ""),
					in_reply_to: p.inReplyTo ?? null,
					email_references: p.references ?? null,
					thread_id: threads.get(root(r.messageId))!,
					message_id: r.messageId,
					raw_storage_key: rawKey,
					reply_to: addresses(p.replyTo) || null,
					delivery_status: r.folder === "sent" ? "sent" : "received",
				};
				if (
					Object.values(record).some(
						(v) => typeof v === "string" && v.includes("\0"),
					)
				)
					throw Error("NUL character requires explicit sanitization review");
				await put(rawKey, raw);
				const attachments = [];
				for (let i = 0; i < p.attachments.length; i++) {
					const a = p.attachments[i];
					if (typeof a.content === "string")
						throw Error("Unexpected attachment encoding");
					const bytes = new Uint8Array(a.content),
						key = uuid(
							id +
								":attachment:" +
								i +
								":" +
								createHash("sha256").update(bytes).digest("hex"),
						);
					await put(key, bytes);
					attachments.push({
						id: key,
						mailbox_id: mailbox,
						email_id: id,
						filename: a.filename ?? "attachment",
						mimetype: a.mimeType,
						size: bytes.byteLength,
						storage_key: key,
					});
				}
				prepared.push({ index: r.index, hash: r.hash, record, attachments });
			});
			prepared.sort(
				(a, b) =>
					a.record.date.getTime() - b.record.date.getTime() ||
					a.index - b.index,
			);
			await log({
				event: "prepared",
				at: new Date(),
				mailbox,
				items: prepared.map((x) => ({
					index: x.index,
					id: x.record.id,
					hash: x.hash,
					thread: x.record.thread_id,
					raw: x.record.raw_storage_key,
					attachments: x.attachments.map((a) => a.id),
				})),
			});
			const inserted = await db.begin(async (tx) => {
				// Coordinate each batch with migrations; re-check guards after any release.
				await tx`SELECT pg_advisory_xact_lock_shared(7342201)`;
				const guarded =
					await tx`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' AND p.proname IN ('classifier_email_changed','enqueue_agent_draft','inbox_message_thread','emit_inbox_webhook') AND position('inbox.historical_import' in pg_get_functiondef(p.oid))>0`;
				if (guarded.length !== 4)
					throw Error("Import guards changed during the run");
				const unexpected =
					await tx`SELECT tgname FROM pg_trigger WHERE tgrelid='public.emails'::regclass AND NOT tgisinternal AND tgenabled IN ('O','A') AND tgname NOT IN ('register_email_conversation','zz_classifier_email_changed','agent_incoming_email','status_email_insert','maintain_mailbox_contacts','webhook_email')`;
				if (unexpected.length)
					throw Error("New email trigger requires import review");
				await tx`SELECT pg_advisory_xact_lock(hashtext(${mailbox}))`;
				await tx`SELECT set_config('inbox.historical_import','on',true)`;
				const rows =
					await tx`INSERT INTO emails ${tx(prepared.map((x) => x.record))} ON CONFLICT(mailbox_id,message_id) DO NOTHING RETURNING id`;
				const ids = new Set(rows.map((r) => r.id));
				const attachments = prepared
					.filter((x) => ids.has(x.record.id))
					.flatMap((x) => x.attachments);
				if (attachments.length)
					await tx`INSERT INTO attachments ${tx(attachments)}`;
				return rows.map((r) => r.id);
			});
			await log({
				event: "committed",
				at: new Date(),
				mailbox,
				ids: inserted,
				processed: prepared.map((x) => x.index),
			});
			insertedTotal += inserted.length;
			skippedTotal += prepared.length - inserted.length;
			console.log(
				JSON.stringify({
					mailbox,
					processed: Math.min(offset + 100, selected.length),
					of: selected.length,
					inserted: insertedTotal,
					racingDuplicates: skippedTotal,
				}),
			);
		}
		console.log(
			JSON.stringify({
				complete: true,
				mailbox,
				inserted: insertedTotal,
				skipped: skippedTotal,
			}),
		);
	}
} finally {
	await proxy?.dispose();
	await source.close();
	await db.end();
}
