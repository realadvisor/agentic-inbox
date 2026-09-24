import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Database } from "./db";
import { groupQuestion, tagGroupInput } from "../shared/tag-groups";

export function tagGroupsApi(db: Database, admin: boolean) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		if (c.req.method !== "GET" && !admin)
			throw new HTTPException(403, {
				message: "Only inbox administrators can edit tag groups.",
			});
		await next();
	});
	app.get("/", async (c) =>
		c.json(
			await db`SELECT g.*,coalesce((SELECT json_agg(json_build_object('id',t.id,'name',t.name,'color',t.color,'description',t.description) ORDER BY t.position,t.id) FROM tags t WHERE t.group_id=g.id AND t.archived_at IS NULL),'[]'::json) AS tags FROM tag_groups g ORDER BY lower(g.name),g.id`,
		),
	);
	async function save(groupId: string, body: unknown, creating: boolean) {
		const input = tagGroupInput.parse(body);
		return db.begin(async (tx) => {
			// Serialize catalogue edits; classifier jobs already lock their own classifier.
			await tx`SELECT pg_advisory_xact_lock(7342211)`;
			const [old] =
				await tx`SELECT * FROM tag_groups WHERE id=${groupId} FOR UPDATE`;
			if (!creating && !old) throw new HTTPException(404);
			if (!creating && input.revision !== old.revision)
				throw new HTTPException(409, {
					message:
						"This group changed. Close the editor and reload before saving.",
				});
			const tagIds = input.tags.map((tag) => tag.id);
			const foreign =
				await tx`SELECT id FROM tags WHERE id IN ${tx(tagIds)} AND group_id IS DISTINCT FROM ${groupId}::uuid`;
			if (foreign.length)
				throw new HTTPException(400, {
					message:
						"Tags already belonging to another catalogue entry cannot be moved here.",
				});
			const [{ count }] =
				await tx`SELECT count(*)::int AS count FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.archived_at IS NULL AND t.group_id IS DISTINCT FROM ${groupId}::uuid`;
			if (count + tagIds.length > 50)
				throw new HTTPException(400, {
					message: "A maximum of 50 classifier tags is supported.",
				});
			if (creating)
				await tx`INSERT INTO tag_groups(id,name,selection,instructions,enabled) VALUES(${groupId},${input.name},${input.selection},${input.instructions},${input.enabled})`;
			// Match the existing classifier editor's invalidation: preserve manual tags,
			// cancel old jobs and historical runs, and classify new mail after enabling.
			const classifiers =
				await tx`SELECT c.id FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.group_id=${groupId} ORDER BY c.id FOR UPDATE OF c`;
			if (classifiers.length) {
				const ids = classifiers.map((c) => c.id);
				await tx`UPDATE classifier_runs SET status='cancelled' WHERE classifier_id IN ${tx(ids)} AND status='running'`;
				await tx`UPDATE classifier_run_items i SET status='skipped' FROM classifier_runs r WHERE r.id=i.run_id AND r.classifier_id IN ${tx(ids)} AND i.status='pending'`;
				await tx`DELETE FROM conversation_classifications WHERE classifier_id IN ${tx(ids)}`;
				await tx`DELETE FROM classifier_examples WHERE classifier_id IN ${tx(ids)}`;
				await tx`DELETE FROM conversation_tags ct USING tags t WHERE ct.tag_id=t.id AND t.group_id=${groupId} AND ct.source='classifier'`;
			}
			const removed =
				await tx`SELECT id FROM tags WHERE group_id=${groupId} AND archived_at IS NULL AND id NOT IN ${tx(tagIds)}`;
			// Keep classifier/run references for audit; retired options disappear from
			// the catalogue and conversations but are never reassigned by new jobs.
			if (removed.length) {
				const ids = removed.map((tag) => tag.id);
				await tx`UPDATE classifiers SET enabled=false,revision=revision+1 WHERE tag_id IN ${tx(ids)}`;
				await tx`UPDATE tags SET archived_at=now() WHERE id IN ${tx(ids)}`;
			}
			if (old?.selection === "multiple" && input.selection === "single") {
				const conflicts =
					await tx`SELECT ct.thread_id FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id WHERE t.group_id=${groupId} AND ct.removed_at IS NULL GROUP BY ct.mailbox_id,ct.thread_id HAVING count(*)>1 LIMIT 1`;
				if (conflicts.length)
					throw new HTTPException(409, {
						message:
							"Some conversations have multiple tags from this group. Resolve those choices before switching to one tag.",
					});
			}
			// Allow two existing option labels to be swapped in the same save.
			await tx`UPDATE tags SET name=id::text WHERE group_id=${groupId} AND archived_at IS NULL`;
			for (const [position, tag] of input.tags.entries()) {
				await tx`INSERT INTO tags(id,name,color,group_id,position,description) VALUES(${tag.id},${tag.name},${tag.color},${groupId},${position},${tag.description}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,color=excluded.color,description=excluded.description,position=excluded.position,archived_at=NULL,updated_at=now()`;
				await tx`INSERT INTO classifiers(tag_id,question,enabled) VALUES(${tag.id},${groupQuestion(input, tag)},${input.enabled}) ON CONFLICT(tag_id) DO UPDATE SET question=excluded.question,enabled=excluded.enabled,revision=classifiers.revision+1,updated_at=now()`;
			}
			const [group] =
				await tx`UPDATE tag_groups SET name=${input.name},selection=${input.selection},instructions=${input.instructions},enabled=${input.enabled},revision=revision+${creating ? 0 : 1},updated_at=now() WHERE id=${groupId} RETURNING *`;
			return { ...group, tags: input.tags };
		});
	}
	app.post("/", async (c) =>
		c.json(await save(crypto.randomUUID(), await c.req.json(), true), 201),
	);
	app.put("/:id", async (c) =>
		c.json(
			await save(
				z.string().uuid().parse(c.req.param("id")),
				await c.req.json(),
				false,
			),
		),
	);
	app.delete("/:id", async (c) => {
		const groupId = z.string().uuid().parse(c.req.param("id"));
		const revision = z.coerce
			.number()
			.int()
			.positive()
			.parse(c.req.query("revision"));
		if (c.req.query("confirm") !== "true")
			throw new HTTPException(400, {
				message: "Deleting a shared group requires confirm=true",
			});
		await db.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(7342211)`;
			const [group] =
				await tx`SELECT revision FROM tag_groups WHERE id=${groupId} FOR UPDATE`;
			if (!group) throw new HTTPException(404, { message: "Group not found" });
			if (group.revision !== revision)
				throw new HTTPException(409, {
					message:
						"This group changed. Close the editor and reload before deleting.",
				});
			const classifiers =
				await tx`SELECT c.id FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE t.group_id=${groupId} ORDER BY c.id FOR UPDATE OF c`;
			if (classifiers.length) {
				const ids = classifiers.map((c) => c.id);
				await tx`UPDATE classifiers SET enabled=false,revision=revision+1,updated_at=now() WHERE id IN ${tx(ids)}`;
				await tx`UPDATE classifier_runs SET status='cancelled' WHERE classifier_id IN ${tx(ids)} AND status='running'`;
				await tx`UPDATE classifier_run_items i SET status='skipped' FROM classifier_runs r WHERE r.id=i.run_id AND r.classifier_id IN ${tx(ids)} AND i.status='pending'`;
				await tx`DELETE FROM conversation_classifications WHERE classifier_id IN ${tx(ids)}`;
				await tx`DELETE FROM classifier_examples WHERE classifier_id IN ${tx(ids)}`;
			}
			await tx`DELETE FROM conversation_tags ct USING tags t WHERE ct.tag_id=t.id AND t.group_id=${groupId}`;
			// Retain tags and classifiers referenced by historical runs, but retire them
			// before detaching the group so they never become standalone catalogue entries.
			await tx`UPDATE tags SET archived_at=coalesce(archived_at,now()),group_id=NULL,updated_at=now() WHERE group_id=${groupId}`;
			await tx`DELETE FROM tag_groups WHERE id=${groupId}`;
		});
		return c.body(null, 204);
	});
	return app;
}
