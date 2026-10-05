import { test } from "node:test";
import assert from "node:assert/strict";
import { translationBatches } from "../server/agent/translation-batches";

test("short emails use one request and remove only boundary whitespace", () => {
	const batches = translationBatches([{ id: 0, text: "\n  Hello  world \t" }]);
	assert.deepEqual(batches, [
		{
			segments: [{ id: 0, text: "Hello  world" }],
			contextBefore: [],
			contextAfter: [],
		},
	]);
});

test("fragmented HTML uses at most three ordered batches with bounded neighboring context", () => {
	const source = Array.from({ length: 500 }, (_, id) => ({
		id,
		text: ` Text ${id} `,
	}));
	const batches = translationBatches(source);
	assert.equal(batches.length, 3);
	assert.deepEqual(
		batches.flatMap((b) => b.segments),
		source.map((s) => ({ ...s, text: s.text.trim() })),
	);
	for (const batch of batches) {
		assert.ok(batch.contextBefore.length <= 2);
		assert.ok(batch.contextAfter.length <= 2);
	}
	assert.deepEqual(
		batches[0].contextAfter,
		batches[1].segments.slice(0, 2).map((s) => s.text),
	);
	assert.deepEqual(
		batches[1].contextBefore,
		batches[0].segments.slice(-2).map((s) => s.text),
	);
});
