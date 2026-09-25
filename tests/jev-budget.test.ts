import { test } from "node:test";
import assert from "node:assert/strict";
import { requestFits, providerError } from "../shared/jev-budget";
import { askJev } from "../server/classification/queue";
import { batchRequests } from "../server/classification/batch";

test("budget checks both individual questions and combined request including Unicode", () => {
	assert.equal(requestFits("short", { a: "x".repeat(27000) }), true);
	assert.equal(requestFits("short", { a: "x".repeat(28000) }), false);
	assert.equal(
		requestFits("short", {
			a: "x".repeat(20000),
			b: "x".repeat(20000),
			c: "x".repeat(20000),
		}),
		false,
	);
	assert.equal(requestFits("短".repeat(10000), { a: "question" }), false);
});
test("oversized single requests never reach provider; token errors retain a specific code", async () => {
	let calls = 0;
	await assert.rejects(
		askJev("key", "question", "x".repeat(30000), async () => {
			calls++;
			return Response.json({});
		}),
		/provider_context_limit/,
	);
	assert.equal(calls, 0);
	assert.equal(
		providerError(400, { detail: { error_type: "max_tokens_exceeded" } }),
		"provider_context_limit",
	);
	assert.equal(
		providerError(400, { detail: { error_type: "other" } }),
		"provider_http_400",
	);
});
test("token rejection splits distinct questions once and preserves answers", async () => {
	let calls = 0;
	const batch = batchRequests(async (_url, init) => {
		calls++;
		const p = JSON.parse(String(init?.body));
		if (Object.keys(p.questions).length > 1)
			return Response.json(
				{ detail: { error_type: "max_tokens_exceeded" } },
				{ status: 400 },
			);
		return Response.json({
			answers: Object.fromEntries(
				Object.keys(p.questions).map((k) => [k, { type: "noul", noul: 0.9 }]),
			),
		});
	}, 2);
	const responses = await Promise.all(
		[0, 1].map((i) =>
			batch.forJob(i)("https://example.test", {
				body: JSON.stringify({
					model: "jev-latest",
					state: "same",
					questions: { match: { type: "noul", instructions: `Q${i}` } },
				}),
			}),
		),
	);
	assert.equal(calls, 3);
	for (const response of responses)
		assert.equal((await response.json()).answers.match.noul, 0.9);
});

test("token recovery drops examples once and never drops conversation text", async () => {
	let calls = 0;
	const batch = batchRequests(async (_url, init) => {
		calls++;
		const p = JSON.parse(String(init?.body));
		assert.equal(p.state, "Full conversation");
		return Response.json(
			{ detail: { error_type: "max_tokens_exceeded" } },
			{ status: 400 },
		);
	}, 1);
	const response = await batch.forJob(0)("https://example.test", {
		body: JSON.stringify({
			model: "jev-latest",
			state: "Full conversation",
			questions: {
				match: {
					type: "noul",
					instructions:
						"Question\n\nHistorical human-labeled examples (guidance only; classify the current state, never these examples):\n[]",
				},
			},
		}),
	});
	assert.equal(response.status, 400);
	assert.equal(calls, 2);
});
