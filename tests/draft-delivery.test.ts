import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftDeliveryLedger } from "../app/lib/draft-delivery";

function fixture() {
	const values = new Map<string, string>();
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
	};
	return { storage, ledger: new DraftDeliveryLedger(() => storage) };
}

test("accepted delivery survives failed cleanup, reload, another tab, and repeated submission", async () => {
	const { storage, ledger } = fixture();
	let sends = 0;
	const send = async () => {
		sends++;
	};
	assert.equal(await ledger.submit("mailbox", "draft", send), true);
	await assert.rejects(
		ledger.cleanup("mailbox", "draft", async () => {
			throw new Error("delete failed");
		}),
	);
	assert.equal(ledger.read("mailbox", "draft"), "accepted");
	const reopened = new DraftDeliveryLedger(() => storage);
	assert.equal(await reopened.submit("mailbox", "draft", send), false);
	let deletes = 0;
	assert.equal(
		await reopened.cleanup("mailbox", "draft", async () => {
			deletes++;
		}),
		true,
	);
	assert.equal(await ledger.submit("mailbox", "draft", send), false);
	assert.equal(ledger.read("mailbox", "draft"), "cleaned");
	assert.equal(sends, 1);
	assert.equal(deletes, 1);
});

test("uncertain send preserves draft without cleanup or automatic retry", async () => {
	const { ledger } = fixture();
	let sends = 0;
	await assert.rejects(
		ledger.submit("mailbox", "draft", async () => {
			sends++;
			throw new Error("response lost after acceptance");
		}),
	);
	assert.equal(ledger.read("mailbox", "draft"), null);
	assert.equal(
		await ledger.cleanup("mailbox", "draft", async () => {
			assert.fail("must preserve draft");
		}),
		false,
	);
	assert.equal(sends, 1);
});

test("duplicate clicks during an in-flight send do not submit twice", async () => {
	const { ledger } = fixture();
	let finish!: () => void;
	const first = ledger.submit(
		"mailbox",
		"draft",
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	assert.equal(
		await ledger.submit("mailbox", "draft", async () => {
			assert.fail("duplicate send");
		}),
		false,
	);
	finish();
	await first;
	assert.equal(ledger.read("mailbox", "draft"), "accepted");
});

test("storage failure before sending fails closed; after acceptance never becomes send failure", async () => {
	const { storage } = fixture();
	let writes = 0;
	const ledger = new DraftDeliveryLedger(() => ({
		...storage,
		setItem: (key, value) => {
			if (++writes > 1) throw new Error("quota");
			storage.setItem(key, value);
		},
	}));
	assert.equal(await ledger.submit("mailbox", "draft", async () => {}), true);
	assert.equal(ledger.read("mailbox", "draft"), "accepted");
	assert.equal(
		new DraftDeliveryLedger(() => storage).read("mailbox", "draft"),
		null,
	);
	await assert.rejects(
		ledger.submit("mailbox", "another", async () => {
			assert.fail("unsafe send");
		}),
		/browser storage/,
	);
});

test("receipts are scoped to mailbox and draft", async () => {
	const { ledger } = fixture();
	let sends = 0;
	for (const [mailbox, draft] of [
		["a", "draft"],
		["b", "draft"],
		["a", "other"],
	]) {
		await ledger.submit(mailbox, draft, async () => {
			sends++;
		});
	}
	assert.equal(sends, 3);
});

test("lost cleanup response can be retried when the draft is already absent", async () => {
	const { ledger } = fixture();
	await ledger.submit("mailbox", "draft", async () => {});
	await assert.rejects(
		ledger.cleanup("mailbox", "draft", async () => {
			throw new Error("deleted but response lost");
		}),
	);
	await ledger.cleanup("mailbox", "draft", async () => {
		throw Object.assign(new Error("Not found"), { status: 404 });
	});
	assert.equal(ledger.read("mailbox", "draft"), "cleaned");
});
