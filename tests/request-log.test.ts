import { test } from "node:test";
import assert from "node:assert/strict";
import {
	markStart,
	redactMessage,
	redactPath,
	requestFailure,
} from "../server/request-log";

test("failure line keeps class, code, path shape and timing only", () => {
	const request = new Request(
		"https://inbox.example.test/api/v1/mailboxes/all%40example.test/emails?query=secret",
		{ headers: { authorization: "Bearer inbox_secret", cookie: "c=1" } },
	);
	markStart(request);
	const error = Object.assign(
		new Error(
			'invalid input syntax for type uuid: "person@example.test" Key (email)=(person@example.test) already exists',
		),
		{ code: "22P02" },
	);
	const line = requestFailure(
		error,
		request,
		redactPath(new URL(request.url).pathname),
		Date.now() + 5,
	);
	assert.deepEqual(Object.keys(line).sort(), [
		"code",
		"duration_ms",
		"error",
		"event",
		"message",
		"method",
		"path",
		"status",
	]);
	assert.equal(line.code, "22P02");
	assert.equal(line.path, "/api/v1/mailboxes/…/emails");
	assert.ok((line.duration_ms ?? -1) >= 5);
	const text = JSON.stringify(line);
	for (const secret of ["person@", "example.test", "secret", "Bearer", "c=1"])
		assert.ok(!text.includes(secret), secret);
});

test("redaction drops quoted values, key details, addresses and ids", () => {
	assert.equal(
		redactMessage("canceling statement due to statement timeout"),
		"canceling statement due to statement timeout",
	);
	const out = redactMessage(
		"row 7d0c5f2e-1111-4a4a-8b8b-123456789abc for 'Jane' <jane@x.ch> Key (id)=(42)",
	);
	for (const value of ["7d0c5f2e", "Jane", "jane@", "42"])
		assert.ok(!out.includes(value), value);
	assert.ok(redactMessage("x".repeat(500)).length <= 200);
});

test("path keeps route words only", () => {
	assert.equal(
		redactPath(
			"/api/v1/mailboxes/all%40example.test/emails/7d0c5f2e-1111-4a4a-8b8b-123456789abc/reply",
		),
		"/api/v1/mailboxes/…/emails/…/reply",
	);
	assert.equal(redactPath("/api/v1/contacts/Jane%20Doe"), "/api/v1/contacts/…");
	assert.equal(redactPath("/api/v1/x/%E0%A4%A"), "/api/v1/x/…");
});
