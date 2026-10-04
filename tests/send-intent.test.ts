import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { SendIntents } from "../app/services/send-intent";
import api from "../app/services/api";
import { connect } from "../server/db";
import { migrate } from "../server/migrate";
import { InboxStore } from "../server/store";
import { SenderStore } from "../server/senders";
import { createApi } from "../server/api";

function journal() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
}
const schema = "test_send_intent_" + crypto.randomUUID().replaceAll("-", "");
const admin = connect();
const db = connect(process.env.DATABASE_URL, schema);
const mailbox = "privacy@ingest.realadvisor.com";
const privacy = "privacy@realadvisor.com";
const info = "info@realadvisor.com";
const input = {
	sender_identity_id: privacy,
	to: "recipient@example.test",
	subject: "Synthetic send",
	text: "Original content",
};
let parentId: string;
before(async () => {
	await admin`CREATE SCHEMA ${admin(schema)}`;
	await migrate(db);
	const store = new InboxStore(db);
	await store.createMailbox(mailbox, "Synthetic Privacy");
	await store.createMailbox("info@ingest.realadvisor.com", "Synthetic Info");
	await new SenderStore(db).setDefault(privacy);
	parentId = (await store.insert(mailbox, {
		sender: input.to,
		recipient: mailbox,
		subject: input.subject,
		body: "Parent",
		folder_id: "inbox",
		message_id: "<parent@example.test>",
	}))!.id;
});
after(async () => {
	await db.end();
	await admin`DROP SCHEMA ${admin(schema)} CASCADE`;
	await admin.end();
});

for (const kind of ["new", "reply", "forward", "draft"] as const) {
	test(`${kind}: accepted provider response lost, client retry creates one outgoing email`, async () => {
		const draft =
			kind === "draft"
				? await new InboxStore(db).insert(mailbox, {
						sender: privacy,
						sender_identity_id: privacy,
						recipient: input.to,
						subject: input.subject,
						body: input.text,
						folder_id: "draft",
						delivery_status: "draft",
					})
				: undefined;
		const payload = { ...input, draft_id: draft?.id };
		let providerCalls = 0;
		const server = createApi(db, {
			mode: "live",
			actor: "test@example.test",
			readAttachment: async () => null,
			sender: {
				send: async () => {
					providerCalls++;
					return { messageId: `<${crypto.randomUUID()}@example.test>` };
				},
			},
		});
		const requests: { key: string; body: string; url: string }[] = [];
		const storage = journal();
		const previousFetch = globalThis.fetch;
		const previousWindow = Object.getOwnPropertyDescriptor(
			globalThis,
			"window",
		);
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: { sessionStorage: storage, confirm: () => false },
		});
		globalThis.fetch = async (url, options) => {
			const key = (options!.headers as Record<string, string>)[
				"Idempotency-Key"
			];
			requests.push({ key, body: options!.body as string, url: String(url) });
			const response = await server.request(`http://127.0.0.1${url}`, options);
			assert.equal(response.status, 201, await response.clone().text());
			if (requests.length === 1)
				throw new TypeError("Lost response after provider acceptance");
			return response;
		};
		const scope = `${kind}-${crypto.randomUUID()}`;
		const send = () =>
			kind === "reply"
				? api.replyToEmail(mailbox, parentId, payload, scope)
				: kind === "forward"
					? api.forwardEmail(mailbox, parentId, payload, scope)
					: api.sendEmail(mailbox, payload, scope);
		try {
			await assert.rejects(send(), /Lost response/);
			await Promise.all([send(), send()]);
			await send(); // Confirmed composition cannot resend after a cleanup/UI failure.
			assert.equal(providerCalls, 1);
			assert.equal(requests.length, 2);
			assert.deepEqual(requests[0], requests[1]);
			const [count] =
				await db`SELECT count(*)::int AS n FROM outbound_requests WHERE request_id=${requests[0].key}`;
			assert.equal(count.n, 1);
		} finally {
			globalThis.fetch = previousFetch;
			if (previousWindow)
				Object.defineProperty(globalThis, "window", previousWindow);
			else Reflect.deleteProperty(globalThis, "window");
		}
	});
}

test("concurrent identical submissions coalesce; changed content never reaches transport", async () => {
	const storage = journal();
	let calls = 0;
	let finish!: () => void;
	const client = new SendIntents(
		() => storage,
		async () => {
			calls++;
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		},
		() => {
			throw new Error("Must not prompt while in flight");
		},
	);
	const first = client.send("box", "scope", "/send", input);
	const second = client.send("box", "scope", "/send", input);
	await assert.rejects(
		client.send("box", "scope", "/send", { ...input, text: "Changed" }),
		/still being submitted/,
	);
	finish();
	await Promise.all([first, second]);
	assert.equal(calls, 1);
});

test("reload preserves key and exact serialized payload, independent of mutated input object", async () => {
	const storage = journal();
	const requests: string[][] = [];
	const payload = { ...input };
	const first = new SendIntents(
		() => storage,
		async (...args) => {
			requests.push(args);
			throw new Error("network");
		},
		() => false,
	);
	await assert.rejects(
		first.send("box", "old-scope", "/send", payload),
		/network/,
	);
	payload.text = "Changed";
	const reloaded = new SendIntents(
		() => storage,
		async (...args) => {
			requests.push(args);
		},
		() => false,
	);
	await assert.rejects(
		reloaded.send("box", "new-scope", "/send", payload),
		/unresolved/,
	);
	assert.equal(requests.length, 1);
	await reloaded.send("box", "new-scope", "/send", input);
	await reloaded.send("box", "new-scope", "/send", input);
	assert.deepEqual(requests[0], requests[1]);
	assert.equal(requests.length, 2);
});

test("explicit recovery replays only original endpoint and payload, and confirmed scopes stay protected", async () => {
	const storage = journal();
	const requests: string[][] = [];
	let fail = true;
	const client = new SendIntents(
		() => storage,
		async (...args) => {
			requests.push(args);
			if (fail) throw new Error("network");
		},
		() => true,
	);
	await assert.rejects(client.send("box", "draft", "/reply", input), /network/);
	fail = false;
	await assert.rejects(
		client.send("box", "draft", "/send", { ...input, text: "Changed" }),
		/Previous message confirmed/,
	);
	assert.deepEqual(requests[0], requests[1]);
	await assert.rejects(
		client.send("box", "draft", "/send", input),
		/already sent/,
	);
	await client.send("box", "new-composition", "/send", input);
	assert.notEqual(requests[2][2], requests[0][2]);
	await client.send("box", "draft", "/reply", input);
	assert.equal(requests.length, 3);
});

test("storage failure prevents sending, and first validation rejection allows correction", async () => {
	const client = new SendIntents(
		() => {
			throw new Error("storage blocked");
		},
		async () => {
			assert.fail("must not send");
		},
		() => false,
	);
	await assert.rejects(
		client.send("box", "scope", "/send", input),
		/storage blocked/,
	);
	const storage = journal();
	let reject = true;
	const keys: string[] = [];
	const retry = new SendIntents(
		() => storage,
		async (_url, _body, key) => {
			keys.push(key);
			if (reject) throw new Error("validation");
		},
		() => false,
		() => true,
	);
	await assert.rejects(
		retry.send("box", "scope", "/send", input),
		/validation/,
	);
	reject = false;
	await retry.send("box", "scope", "/send", { ...input, text: "corrected" });
	assert.notEqual(keys[0], keys[1]);
});

test("a later definitive rejection cannot release an earlier uncertain send", async () => {
	const storage = journal();
	const first = new SendIntents(
		() => storage,
		async () => {
			throw new Error("network");
		},
		() => false,
	);
	await assert.rejects(first.send("box", "scope", "/send", input));
	const later = new SendIntents(
		() => storage,
		async () => {
			throw new Error("forbidden");
		},
		() => false,
		() => true,
	);
	await assert.rejects(later.send("box", "scope", "/send", input), /forbidden/);
	await assert.rejects(
		later.send("box", "scope", "/send", { ...input, text: "changed" }),
		/unresolved/,
	);
});

test("provider uncertainty never generates another provider call or unlocks edited content", async () => {
	const storage = journal();
	let calls = 0;
	const keys: string[] = [];
	const server = createApi(db, {
		mode: "live",
		actor: "test@example.test",
		readAttachment: async () => null,
		sender: {
			send: async () => {
				calls++;
				throw new Error("Provider timeout after possible acceptance");
			},
		},
	});
	const makeClient = () =>
		new SendIntents(
			() => storage,
			async (url, body, key) => {
				keys.push(key);
				const res = await server.request(`http://127.0.0.1${url}`, {
					method: "POST",
					body,
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": key,
					},
				});
				if (!res.ok) throw new Error((await res.json()).error);
			},
			() => false,
		);
	const url = `/api/v1/mailboxes/${mailbox}/emails`;
	await assert.rejects(
		makeClient().send(mailbox, "unknown", url, input),
		/not confirmed/,
	);
	await assert.rejects(
		makeClient().send(mailbox, "unknown", url, input),
		/unknown/,
	);
	await assert.rejects(
		makeClient().send(mailbox, "unknown", url, { ...input, text: "Changed" }),
		/unresolved/,
	);
	assert.equal(calls, 1);
	assert.equal(keys.length, 2);
	assert.equal(keys[0], keys[1]);
	const [count] =
		await db`SELECT count(*)::int AS n FROM outbound_requests r JOIN emails e ON e.id=r.email_id WHERE r.request_id=${keys[0]} AND e.delivery_status='unknown'`;
	assert.equal(count.n, 1);
});

for (const lost of ["before acceptance", "after acceptance"]) {
	test(`sender selection and draft ID remain frozen when response is lost ${lost}`, async () => {
		const store = new InboxStore(db);
		const senders = new SenderStore(db);
		await senders.setDefault(privacy);
		const draft = (await store.insert(mailbox, {
			sender: privacy,
			sender_identity_id: privacy,
			recipient: input.to,
			subject: "Frozen sender",
			body: input.text,
			folder_id: "draft",
			delivery_status: "draft",
		}))!;
		const payload = { ...input, draft_id: draft.id };
		const delivered: { from: string; replyTo: string }[] = [];
		const server = createApi(db, {
			mode: "live",
			actor: "test@example.test",
			readAttachment: async () => null,
			sender: {
				send: async (mail) => {
					delivered.push(mail);
					return { messageId: `<${crypto.randomUUID()}@example.test>` };
				},
			},
		});
		const storage = journal();
		const requests: string[][] = [];
		let confirm = false;
		const client = new SendIntents(
			() => storage,
			async (url, body, key) => {
				requests.push([url, body, key]);
				if (requests.length === 1 && lost === "before acceptance")
					throw new Error("Lost response");
				const response = await server.request(`http://127.0.0.1${url}`, {
					method: "POST",
					body,
					headers: {
						"Content-Type": "application/json",
						"Idempotency-Key": key,
					},
				});
				assert.equal(response.status, 201, await response.clone().text());
				if (requests.length === 1) throw new Error("Lost response");
			},
			(message) => {
				assert.match(message, /original sender/);
				return confirm;
			},
		);
		const url = `/api/v1/mailboxes/${mailbox}/emails`;
		await assert.rejects(
			client.send(mailbox, draft.id, url, payload),
			/Lost response/,
		);
		await senders.setDefault(info);
		// Even a subsequent edit to the source draft must not change the stored intent.
		await db`UPDATE emails SET sender_identity_id=${info},sender=${info} WHERE id=${draft.id}`;
		await assert.rejects(
			client.send(mailbox, draft.id, url, {
				...payload,
				sender_identity_id: info,
			}),
			/unresolved/,
		);
		assert.equal(requests.length, 1);
		confirm = true;
		await assert.rejects(
			client.send(mailbox, draft.id, url, {
				...payload,
				sender_identity_id: info,
			}),
			/Previous message confirmed/,
		);
		assert.deepEqual(requests[1], requests[0]);
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0].from, privacy);
		assert.equal(delivered[0].replyTo, privacy);
		const rows =
			await db`SELECT e.sender,e.sender_identity_id FROM outbound_requests r JOIN emails e ON e.id=r.email_id WHERE r.request_id=${requests[0][2]}`;
		assert.equal(rows.length, 1);
		assert.equal(rows[0].sender_identity_id, privacy);
		await senders.setDefault(privacy);
	});
}

test("corrupt journal values never create a fresh intent", async () => {
	for (const raw of [
		"null",
		"false",
		"{}",
		"not-json",
		JSON.stringify({
			scope: "scope",
			key: "key",
			url: "/send",
			body: "{}",
			confirmed: false,
			scopes: [null],
		}),
	]) {
		const storage = journal();
		storage.setItem("inbox-send-intent:v1:box", raw);
		const client = new SendIntents(
			() => storage,
			async () => {
				assert.fail("corrupt journal must not send");
			},
			() => false,
		);
		await assert.rejects(client.send("box", "scope", "/send", input));
		assert.equal(storage.getItem("inbox-send-intent:v1:box"), raw);
	}
});

test("failed confirmation receipt keeps every remounted scope on the original key", async () => {
	const stored = journal();
	let failReceipt = true;
	const storage = {
		...stored,
		setItem: (key: string, value: string) => {
			if (failReceipt && key.endsWith(":completed:remounted"))
				throw new Error("Storage quota");
			stored.setItem(key, value);
		},
	};
	const keys: string[] = [];
	const transport = async (_url: string, _body: string, key: string) => {
		keys.push(key);
		if (keys.length === 1) throw new Error("Lost response");
	};
	const makeClient = () =>
		new SendIntents(
			() => storage,
			transport,
			() => false,
		);
	await assert.rejects(
		makeClient().send("box", "original", "/send", input),
		/Lost response/,
	);
	await assert.rejects(
		makeClient().send("box", "remounted", "/send", input),
		/Storage quota/,
	);
	await assert.rejects(
		makeClient().send("box", "another", "/send", { ...input, text: "Changed" }),
		/unresolved/,
	);
	failReceipt = false;
	await makeClient().send("box", "remounted", "/send", input);
	await makeClient().send("box", "original", "/send", input);
	await makeClient().send("box", "remounted", "/send", input);
	assert.equal(keys.length, 3);
	assert.equal(new Set(keys).size, 1);
});
