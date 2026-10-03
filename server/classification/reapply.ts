import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "../db";
import {
	groupChoice,
	interpretAnswer,
	jevQuestion,
} from "../../shared/jev-request";
import { tagGroupInput } from "../../shared/tag-groups";
const input = z
	.object({
		classifier_ids: z.array(z.string().uuid()).min(1).max(100),
		apply: z.boolean().default(false),
		fingerprint: z.string().optional(),
		before: z.string().datetime().optional(),
		cursor: z
			.object({ mailbox: z.string(), thread: z.string().uuid() })
			.optional(),
	})
	.strict();
export function reapplyApi(db: Database, actor: string) {
	const app = new Hono();
	app.post("/", async (c) => {
		const data = input.parse(await c.req.json());
		return c.json(
			await db.begin(async (tx) => {
				// Match catalogue edit lock ordering before locking classifier definitions.
				await tx`SELECT pg_advisory_xact_lock(7342211)`;
				const definitions =
					await tx`SELECT c.*,t.group_id,t.name,t.description,t.color,t.position,g.selection,g.instructions,g.name AS group_name FROM classifiers c JOIN tags t ON t.id=c.tag_id LEFT JOIN tag_groups g ON g.id=t.group_id WHERE c.id IN ${tx(data.classifier_ids)} AND t.archived_at IS NULL ORDER BY c.id FOR UPDATE OF c`;
				if (definitions.length !== new Set(data.classifier_ids).size)
					throw new HTTPException(409, {
						message: "Classifier changed; reload settings",
					});
				const missing =
					await tx`SELECT c.id FROM classifiers c JOIN tags t ON t.id=c.tag_id JOIN tag_groups g ON g.id=t.group_id WHERE g.selection IN ('single','score') AND t.archived_at IS NULL AND t.group_id IN (SELECT t.group_id FROM tags t JOIN classifiers c ON c.tag_id=t.id WHERE c.id IN ${tx(data.classifier_ids)}) AND c.id NOT IN ${tx(data.classifier_ids)} LIMIT 1`;
				if (missing.length)
					throw new HTTPException(400, {
						message: "Select all tags in a choice group",
					});
				const fingerprint = JSON.stringify(
					definitions.map((d) => [
						d.id,
						d.revision,
						d.decision_rules,
						d.enabled,
						d.selection,
					]),
				);
				if (
					(data.apply && !data.fingerprint) ||
					(data.fingerprint && fingerprint !== data.fingerprint)
				)
					throw new HTTPException(409, {
						message: "Rules changed; preview again",
					});
				const before = data.before ?? new Date().toISOString();
				const candidates =
					await tx`SELECT DISTINCT mailbox_id,thread_id FROM conversation_classifications WHERE classifier_id IN ${tx(data.classifier_ids)} AND status='review' AND updated_at<=${before}::timestamptz ${data.cursor ? tx`AND (mailbox_id,thread_id)>(${data.cursor.mailbox},${data.cursor.thread}::uuid)` : tx``} ORDER BY mailbox_id,thread_id LIMIT 50`;
				let resolved = 0,
					remaining = 0;
				for (const candidate of candidates) {
					const [conversation] =
						await tx`SELECT generation FROM conversations WHERE mailbox_id=${candidate.mailbox_id} AND thread_id=${candidate.thread_id} FOR UPDATE`;
					const jobs =
						await tx`SELECT j.*,tag_manually_overridden(j.mailbox_id,j.thread_id,c.tag_id) AS manual,log.response_body,log.question_key FROM conversation_classifications j JOIN classifiers c ON c.id=j.classifier_id LEFT JOIN LATERAL (SELECT r.response_body,i.question_key FROM classifier_provider_run_items i JOIN classifier_provider_runs r ON r.id=i.run_id WHERE i.job_token=j.token AND i.classifier_id=j.classifier_id AND i.revision=j.revision AND i.generation=j.generation AND r.status='succeeded' ORDER BY r.started_at DESC LIMIT 1) log ON true WHERE j.mailbox_id=${candidate.mailbox_id} AND j.thread_id=${candidate.thread_id} AND j.classifier_id IN ${tx(data.classifier_ids)} ORDER BY j.classifier_id FOR UPDATE OF j`;
					const units = new Map<string, (typeof definitions)[number][]>();
					for (const d of definitions) {
						const key = ["single", "score"].includes(d.selection)
							? d.group_id
							: d.id;
						const unit = units.get(key) ?? [];
						unit.push(d);
						units.set(key, unit);
					}
					for (const unit of units.values()) {
						const rows = unit.map((d) =>
							jobs.find((j) => j.classifier_id === d.id),
						);
						if (!rows.some((j) => j?.status === "review")) continue;
						if (
							rows.some(
								(j, i) =>
									!j ||
									j.status !== "review" ||
									j.source !== "jev" ||
									j.error ||
									j.manual ||
									j.revision !== unit[i].revision ||
									j.generation !== conversation?.generation ||
									(!unit[i].enabled && j.priority !== 2) ||
									new Date(j.updated_at) > new Date(before),
							)
						) {
							remaining++;
							continue;
						}
						try {
							const group = ["single", "score"].includes(unit[0].selection);
							const question = group
								? groupChoice(
										tagGroupInput.parse({
											name: unit[0].group_name,
											selection: unit[0].selection,
											instructions: unit[0].instructions,
											enabled: true,
											decision_rules: unit[0].decision_rules,
											tags: [...unit]
												.sort((a, b) => a.position - b.position)
												.map((d) => ({
													id: d.tag_id,
													name: d.name,
													description: d.description,
													color: d.color,
												})),
										}),
									)
								: jevQuestion(unit[0].question);
							const answers = rows.map((j, i) =>
								interpretAnswer(
									question,
									JSON.parse(j!.response_body)?.answers?.[j!.question_key],
									group ? unit[i].tag_id : undefined,
									unit[i].decision_rules,
								),
							);
							if (
								answers.some((a) => a.answer === null) ||
								(group && answers.filter((a) => a.answer === true).length !== 1)
							) {
								remaining++;
								continue;
							}
							resolved++;
							if (!data.apply) continue;
							// Clear losing automatic options first, preserving single-choice constraints.
							for (const i of answers
								.map((_, i) => i)
								.sort(
									(a, b) =>
										Number(answers[a].answer) - Number(answers[b].answer),
								)) {
								const j = rows[i]!,
									a = answers[i],
									d = unit[i];
								await tx`UPDATE conversation_classifications SET status='complete',answer=${a.answer},probability=${a.probability},actor=${actor},updated_at=now() WHERE token=${j.token}`;
								await tx`INSERT INTO conversation_tags(mailbox_id,thread_id,tag_id,source,actor,removed_at) VALUES(${j.mailbox_id},${j.thread_id},${d.tag_id},'classifier',${actor},${a.answer ? null : tx`now()`}) ON CONFLICT(mailbox_id,thread_id,tag_id) DO UPDATE SET actor=excluded.actor,removed_at=excluded.removed_at,updated_at=now() WHERE conversation_tags.source='classifier'`;
								if (j.run_id)
									await tx`UPDATE classifier_run_items SET status='complete' WHERE run_id=${j.run_id} AND mailbox_id=${j.mailbox_id} AND thread_id=${j.thread_id} AND status='review'`;
							}
						} catch (error) {
							if (
								error instanceof SyntaxError ||
								(error instanceof Error &&
									[
										"invalid_provider_answer",
										"invalid_score_boundaries",
									].includes(error.message))
							) {
								remaining++;
								continue;
							}
							throw error;
						}
					}
				}
				const last = candidates.at(-1);
				return {
					resolved,
					remaining,
					fingerprint,
					before,
					cursor:
						candidates.length === 50 && last
							? { mailbox: last.mailbox_id, thread: last.thread_id }
							: null,
				};
			}),
		);
	});
	return app;
}
