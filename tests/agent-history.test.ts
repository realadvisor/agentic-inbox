import { test } from "node:test";
import assert from "node:assert/strict";
import {
	convertToModelMessages,
	type ToolCallPart,
	type ToolResultPart,
} from "ai";
import { portableHistory, buildHistory } from "../server/agent/history";
import { agentErrorMessage } from "../server/agent/errors";
import type { InboxChatMessage, AgentTurn } from "../shared/agent";

test("portable history repairs interrupted tools and invalid input without mutating persisted data", async () => {
	const original = {
		id: "a",
		role: "assistant",
		parts: [
			{
				type: "reasoning",
				text: "private reasoning",
				providerMetadata: { anthropic: { signature: "old" } },
			},
			{
				type: "dynamic-tool",
				toolName: "get_email",
				toolCallId: "a/b",
				state: "output-available",
				input: '{"emailId":"example"}',
				output: { id: "first" },
			},
			{
				type: "dynamic-tool",
				toolName: "get_email",
				toolCallId: "a:b",
				state: "output-error",
				input: "broken",
				rawInput: "broken",
				errorText: "secret raw provider failure",
			},
			{
				type: "dynamic-tool",
				toolName: "draft_reply",
				toolCallId: "pending",
				state: "input-available",
				input: { body: "hello" },
			},
		],
	} as unknown as InboxChatMessage;
	const before = JSON.stringify(original);
	const sanitized = portableHistory(original, "0");
	assert.equal(JSON.stringify(original), before);
	const messages = await convertToModelMessages([sanitized]);
	const calls: ToolCallPart[] = [];
	const results: ToolResultPart[] = [];
	for (const message of messages) {
		if (typeof message.content === "string") continue;
		for (const part of message.content) {
			if (part.type === "tool-call") calls.push(part);
			if (part.type === "tool-result") results.push(part);
		}
	}
	assert.equal(calls.length, 3);
	assert.equal(results.length, 3);
	assert.equal(new Set(calls.map((c) => c.toolCallId)).size, 3);
	for (const call of calls) {
		assert.match(call.toolCallId, /^[a-zA-Z0-9_-]+$/);
		assert.ok(results.some((r) => r.toolCallId === call.toolCallId));
		assert.equal(typeof call.input, "object");
	}
	assert.doesNotMatch(
		JSON.stringify(messages),
		/old|private reasoning|secret raw/,
	);
});

test("empty and reasoning-only messages remain valid history", async () => {
	for (const parts of [
		[],
		[{ type: "reasoning" as const, text: "thinking" }],
	]) {
		const converted = await convertToModelMessages([
			portableHistory({ id: "x", role: "assistant", parts }, "0"),
		]);
		assert.match(JSON.stringify(converted), /Response interrupted/);
	}
});

const turn = (i: number): AgentTurn => ({
	id: String(i),
	model: "test",
	prompt: `Question ${i}`,
	answer: "a".repeat(4000),
	actions: [],
	status: "complete",
	created_at: new Date().toISOString(),
});
test("context keeps more than three turns when budget allows, and drops complete oldest turns for small models", async () => {
	const turns = Array.from({ length: 8 }, (_, i) => turn(i));
	const large = await buildHistory(turns, 128000, "system");
	assert.equal(large.filter((m) => m.role === "user").length, 8);
	const small = await buildHistory(turns, 48000, "system");
	assert.match(JSON.stringify(small), /Question 7/);
	assert.doesNotMatch(JSON.stringify(small), /Question 0/);
	assert.equal(small[0].role, "system");
});
test("failed turns retain saved actions and warn against blind repetition", async () => {
	const t = {
		...turn(1),
		status: "stopped" as const,
		answer: "",
		actions: [{ tool: "draft_reply", result: '{"draft_id":"saved"}' }],
	};
	const messages = await buildHistory([t], 64000, "");
	assert.match(JSON.stringify(messages), /saved/);
	assert.match(JSON.stringify(messages), /stopped/);
});
test("provider errors become actionable messages without leaking raw errors", () => {
	assert.match(
		agentErrorMessage({ statusCode: 429, message: "key secret" }),
		/rate limited/,
	);
	assert.match(agentErrorMessage({ statusCode: 402 }), /credits/);
	assert.doesNotMatch(
		agentErrorMessage(new Error("Bearer secret-key")),
		/secret-key/,
	);
});
