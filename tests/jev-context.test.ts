import { test } from "node:test";
import assert from "node:assert/strict";
import {
	cropConversation,
	prepareOversizedContext,
} from "../shared/jev-context";
import { requestFits } from "../shared/jev-budget";
import { batchRequests } from "../server/classification/batch";
const questions = {
	match: {
		type: "choice",
		instructions: "Classify",
		criteria: { a: "A", b: "B" },
	},
};
test("small inputs remain unchanged", () => {
	const s = { messages: [{ text: "Please cancel the paid contract." }] };
	assert.equal(prepareOversizedContext(s, questions), s);
});
test("cropping retains opening and recent messages, headers, tails and Unicode without mutating originals", () => {
	const s = {
		messages: Array.from({ length: 12 }, (_, i) => ({
			text: `START ${i} ` + "🏠 cancellation ".repeat(3000) + ` END ${i}`,
			subject: `subject${i}`,
			direction: i % 2 ? "outbound" : "inbound",
			attachment_count: 1,
		})),
	};
	const before = JSON.stringify(s);
	const result = cropConversation(s, questions) as typeof s & {
		context_preparation: { omitted_messages: number };
	};
	assert.ok(requestFits(result, questions));
	assert.equal(JSON.stringify(s), before);
	assert.deepEqual(
		result.messages.map((m) => m.subject),
		["subject0", "subject8", "subject9", "subject10", "subject11"],
	);
	assert.equal(result.context_preparation.omitted_messages, 7);
	for (const m of result.messages) {
		assert.ok(m.text.includes("START"));
		assert.ok(m.text.includes("END"));
		assert.ok(m.text.includes("[Middle of message omitted]"));
		assert.equal(m.attachment_count, 1);
		assert.ok(!m.text.includes("\ufffd"));
	}
});
test("removes decorative combining joiner padding but preserves multilingual joiners", () => {
	const s = {
		messages: [
			{
				text:
					"Hello" + "\u034f".repeat(40000) + " world فارسی\u200cمتن 👩\u200d💻",
			},
		],
	};
	const result = prepareOversizedContext(s, questions) as typeof s;
	assert.equal(
		result.messages[0].text,
		"Hello world فارسی\u200cمتن 👩\u200d💻",
	);
});
test("oversized instructions cannot cause unbounded retries or removal of metadata", () => {
	const s = { messages: [{ text: "hi", subject: "keep" }] };
	assert.equal(cropConversation(s, { match: "x".repeat(30000) }), s);
});
test("provider context failure retries cropped state once, with Choice siblings coalesced", async () => {
	let calls = 0;
	const state = {
		messages: [
			{
				text:
					"Important first request. " +
					"words ".repeat(6000) +
					" Latest resolution.",
			},
		],
	};
	const batch = batchRequests(async (_url, init) => {
		calls++;
		const p = JSON.parse(String(init?.body));
		if (calls === 1) assert.deepEqual(p.state, state);
		else {
			assert.equal(p.state.context_preparation.cropped, true);
			assert.ok(requestFits(p.state, p.questions));
		}
		return Response.json(
			{ detail: { error_type: "max_tokens_exceeded" } },
			{ status: 400 },
		);
	}, 2);
	const responses = await Promise.all(
		[0, 1].map((i) =>
			batch.forJob(i)("https://example.test", {
				body: JSON.stringify({ model: "jev-latest", state, questions }),
			}),
		),
	);
	assert.equal(calls, 2);
	for (const r of responses) assert.equal(r.status, 400);
});
