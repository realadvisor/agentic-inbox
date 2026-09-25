import { test } from "node:test";
import assert from "node:assert/strict";
import { batchRequests } from "../server/classification/batch";

test("skipped participants do not stall batching; different snapshots split while fitting questions stay together", async () => {
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
	assert.equal(calls.length, 2);
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

test("split batches stop before leases expire and leave remaining questions retryable", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 1000 });
	let calls = 0;
	const batch = batchRequests(async () => {
		calls++;
		t.mock.timers.setTime(62000);
		return Response.json({ answers: { match: { type: "noul", noul: 0.9 } } });
	}, 2);
	const send = (index: number) =>
		batch.forJob(index)("https://api.typesafe.ai/v1/systemone", {
			method: "POST",
			body: JSON.stringify({
				model: "jev-latest",
				state: { snapshot: index },
				questions: { match: { type: "noul", instructions: "Question" } },
			}),
		});
	const responses = await Promise.allSettled([send(0), send(1)]);
	assert.equal(calls, 1);
	assert.equal(responses[0].status, "fulfilled");
	assert.equal(responses[1].status, "rejected");
});
