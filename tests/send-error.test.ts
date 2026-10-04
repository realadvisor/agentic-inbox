import { test } from "node:test";
import assert from "node:assert/strict";
import { sendErrorMessage } from "../app/lib/send-error";

test("transport and server errors warn about uncertain delivery without offering automatic retry", () => {
	for (const error of [
		new TypeError("Failed to fetch"),
		new DOMException("Timed out", "AbortError"),
		Object.assign(new Error("Server unavailable"), { status: 502 }),
	]) {
		assert.match(
			sendErrorMessage(error),
			/Delivery is unconfirmed.*Your draft is preserved/,
		);
	}
});
test("journal recovery and definite rejection messages retain their precise outcome", () => {
	for (const message of [
		"Previous message confirmed sent. Review Sent before submitting your changed message as a new composition.",
		"Previous send is unresolved. Retry the original content or check the saved request before sending changed content.",
	]) {
		assert.equal(sendErrorMessage(new Error(message)), message);
	}
	const rejected = Object.assign(new Error("Choose an available sender."), {
		status: 400,
	});
	assert.equal(sendErrorMessage(rejected), rejected.message);
});
