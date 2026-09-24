import { test } from "node:test";
import assert from "node:assert/strict";
import { batchRequests } from "../server/classification/batch";

test("skipped participants do not stall batching; different snapshots and large payloads split", async () => {
	const calls: unknown[] = [];
	const request: typeof fetch = async (_url, init) => {
		const body = JSON.parse(init!.body as string);
		calls.push(body);
		return Response.json({
			answers: Object.fromEntries(
				Object.keys(body.questions).map((key) => [
					key,
					{ type: "noul", noul: 0.9 },
				]),
			),
		});
	};
	const batch = batchRequests(request, 4);
	const send = (index: number, state: string, question: string) =>
		batch.forJob(index)("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			body: JSON.stringify({
				model: "jev-latest",
				state,
				questions: { match: { type: "noul", instructions: question } },
			}),
		});
	const promises = [
		send(0, "old snapshot", "A"),
		send(1, "new snapshot", "B"),
		send(2, "new snapshot", "x".repeat(24000)),
	];
	batch.done(3);
	const results = await Promise.all(promises);
	assert.equal(calls.length, 3);
	for (const result of results)
		assert.equal((await result.json()).answers.match.noul, 0.9);
});

test("provider throttling is returned to every job with retry headers intact", async () => {
	let calls = 0;
	const batch = batchRequests(async () => {
		calls++;
		return new Response("slow down", {
			status: 429,
			headers: { "Retry-After": "60" },
		});
	}, 2);
	const send = (i: number) =>
		batch.forJob(i)("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			body: JSON.stringify({
				model: "jev-latest",
				state: {},
				questions: { match: { type: "noul", instructions: "Question" } },
			}),
		});
	const responses = await Promise.all([send(0), send(1)]);
	assert.equal(calls, 1);
	for (const response of responses) {
		assert.equal(response.status, 429);
		assert.equal(response.headers.get("Retry-After"), "60");
	}
});
