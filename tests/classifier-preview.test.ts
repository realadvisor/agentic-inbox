import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "../server/db";
import { createApi } from "../server/api";
import { setupPreview } from "../server/preview/setup";
import { previewApi, tickPreview } from "../server/preview/api";
import { setConversationTags } from "../server/tags";
const schema = "test_preview_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect(),
	db = connect(process.env.DATABASE_URL, schema);
const app = createApi(db, {
	readAttachment: async () => null,
	classifierPreview: true,
	previewRoutes: previewApi(db),
});

before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await setupPreview(db);
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});
async function call(path: string, method = "GET", body?: unknown) {
	return app.request("http://127.0.0.1:4311/api/preview" + path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}
test("preview persists configurations and batches; respects corrections, uniqueness and cancellation", async () => {
	const classifiers = await (await call("/classifiers")).json();
	assert.equal(classifiers.length, 3);
	const c = classifiers.find(
		(x: { fixture_key: string }) => x.fixture_key === "deletion",
	);
	const input = {
		question: c.question,
		tag_id: c.tag_id,
		mailbox_ids: [],
		enabled: false,
	};
	assert.equal((await call("/classifiers", "POST", input)).status, 409);
	const runBody = {
		mailbox_ids: ["privacy@example.test"],
		selection: "unprocessed",
		enable: true,
	};
	const first = await (
		await call(`/classifiers/${c.id}/runs`, "POST", runBody)
	).json();
	const duplicate = await (
		await call(`/classifiers/${c.id}/runs`, "POST", runBody)
	).json();
	assert.equal(first.id, duplicate.id);
	assert.equal(first.total, 6);
	for (let i = 0; i < 6; i++) await tickPreview(db);
	const [run] = await db`SELECT * FROM preview_runs WHERE id=${first.id}`;
	assert.equal(run.status, "completed");
	assert.equal(run.review, 1);
	const [tagged] =
		await db`SELECT * FROM conversation_tags WHERE tag_id=${c.tag_id} AND removed_at IS NULL ORDER BY thread_id`;
	assert.ok(tagged);
	const reviewPath = `/results/privacy@example.test/${tagged.thread_id}/${c.id}`;
	assert.equal(
		(await call(reviewPath, "PUT", { answer: false, revision: c.revision }))
			.status,
		204,
	);
	const rerun = await (
		await call(`/classifiers/${c.id}/runs`, "POST", {
			...runBody,
			selection: "all",
		})
	).json();
	for (let i = 0; i < 6; i++) await tickPreview(db);
	const [preserved] =
		await db`SELECT * FROM preview_classifications WHERE classifier_id=${c.id} AND thread_id=${tagged.thread_id}`;
	assert.equal(preserved.source, "human");
	assert.equal(preserved.answer, false);
	assert.equal(
		(await db`SELECT skipped FROM preview_runs WHERE id=${rerun.id}`)[0]
			.skipped,
		1,
	);
	const reset = await (
		await call(`/classifiers/${c.id}/runs`, "POST", {
			...runBody,
			selection: "all",
			reset: true,
		})
	).json();
	for (let i = 0; i < 6; i++) await tickPreview(db);
	assert.equal(
		(
			await db`SELECT source FROM preview_classifications WHERE classifier_id=${c.id} AND thread_id=${tagged.thread_id}`
		)[0].source,
		"fixture",
	);
	assert.equal(reset.total, 6);
	await setConversationTags(
		db,
		"privacy@example.test",
		[tagged.thread_id],
		c.tag_id,
		"remove",
		"test",
	);
	await call(`/classifiers/${c.id}/runs`, "POST", {
		...runBody,
		selection: "all",
		reset: true,
	});
	for (let i = 0; i < 6; i++) await tickPreview(db);
	assert.equal(
		(
			await db`SELECT source FROM conversation_tags WHERE thread_id=${tagged.thread_id} AND tag_id=${c.tag_id}`
		)[0].source,
		"manual",
	);
	const cancel = await (
		await call(`/classifiers/${c.id}/runs`, "POST", {
			...runBody,
			selection: "all",
		})
	).json();
	await call(`/classifiers/${c.id}/cancel`, "POST", {});
	await tickPreview(db);
	assert.equal(
		(await db`SELECT processed FROM preview_runs WHERE id=${cancel.id}`)[0]
			.processed,
		0,
	);
	await call(`/classifiers/${c.id}`, "PUT", {
		...input,
		mailbox_ids: ["privacy@example.test"],
		enabled: true,
	});
	assert.equal(
		(
			await call(`/classifiers/${c.id}/runs`, "POST", {
				...runBody,
				mailbox_ids: ["info@example.test"],
			})
		).status,
		400,
	);
});
test("preview endpoints are absent in the normal application", async () => {
	const ordinary = createApi(db, { readAttachment: async () => null });
	assert.equal(
		(await ordinary.request("http://127.0.0.1:4311/api/preview/classifiers"))
			.status,
		404,
	);
});
