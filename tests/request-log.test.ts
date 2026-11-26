import { test } from "node:test";
import assert from "node:assert/strict";
import {
	background,
	guarded,
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

const captured = () => {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map(String).join(" "));
	};
	return { lines, restore: () => (console.error = original) };
};

test("only database errors keep a (redacted) message", () => {
	const fetchError = new Error(
		"GET https://api.example.test/v1?token=abc123secret failed with inbox_0123456789abcdef0123 Bearer eyJhbGciOiJIUzI1NiJ9.payload",
	);
	const line = requestFailure(
		fetchError,
		new Request("https://x.test/a"),
		"/a",
	);
	assert.equal(line.message, null);
	assert.equal(line.code, null);
	const text = JSON.stringify(line);
	for (const secret of ["token", "abc123", "inbox_0123", "eyJ", "example.test"])
		assert.ok(!text.includes(secret), secret);
	const db = Object.assign(
		new Error(
			"timeout at https://h.test/?token=abc inbox_0123456789abcdef0123",
		),
		{ code: "57014" },
	);
	const kept = requestFailure(db, new Request("https://x.test/a"), "/a");
	assert.equal(kept.code, "57014");
	for (const secret of ["token=abc", "inbox_0123"])
		assert.ok(!String(kept.message).includes(secret), secret);
});

test("email() failures are logged redacted and rethrown without mail text", async () => {
	const { default: worker } = await import("../server/worker");
	const log = captured();
	const message = {
		get to(): string {
			throw new Error("Subject: secret plan from person@example.test");
		},
		from: "person@example.test",
		raw: new ReadableStream(),
		rawSize: 1,
		setReject() {},
	};
	const env = {
		MAIL_MODE: "live",
		INBOUND_ENABLED: "true",
		ACCESS_ISSUER: "https://issuer.example.test",
		ACCESS_AUDIENCE: "aud",
		ATTACHMENTS: { get: async () => null, put: async () => {} },
		HYPERDRIVE: { connectionString: "postgres://unused.invalid/test" },
	};
	try {
		await assert.rejects(
			worker.email(
				message,
				env as unknown as Parameters<typeof worker.email>[1],
			),
			(error: Error) => !/secret|person@/.test(error.message),
		);
	} finally {
		log.restore();
	}
	assert.equal(log.lines.length, 1);
	const line = JSON.parse(log.lines[0]!);
	assert.equal(line.event, "inbox_email_failed");
	assert.ok(!/secret|person@|Subject/.test(log.lines[0]!));
});

test("guarded and background never pass error text on", async () => {
	const log = captured();
	try {
		await assert.rejects(
			guarded("x_failed", async () => {
				throw new Error("person@example.test said hi");
			}),
			{ message: "x_failed: see the redacted log line" },
		);
		await background(
			"y_failed",
			Promise.reject(new Error("https://h.test/?t=1")),
		);
	} finally {
		log.restore();
	}
	assert.equal(log.lines.length, 2);
	assert.ok(!/person@|h\.test/.test(log.lines.join("\n")));
});
