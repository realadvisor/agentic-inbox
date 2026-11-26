import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyCanRequest } from "../server/api-keys";

describe("inbound support API key allowlist", () => {
	const mailbox = "all@ingest.realadvisor.com";
	const path = `/api/v1/mailboxes/${encodeURIComponent(mailbox)}/inbound`;

	it("allows POST /inbound with conversations:manage on the scoped mailbox", () => {
		assert.equal(
			keyCanRequest(
				{
					id: "k1",
					mailbox_ids: [mailbox],
					permissions: ["conversations:manage"],
				},
				"POST",
				path,
			),
			true,
		);
	});

	it("denies POST /inbound without conversations:manage or for another mailbox", () => {
		assert.equal(
			keyCanRequest(
				{
					id: "k1",
					mailbox_ids: [mailbox],
					permissions: ["mail:read", "mail:send"],
				},
				"POST",
				path,
			),
			false,
		);
		assert.equal(
			keyCanRequest(
				{
					id: "k1",
					mailbox_ids: ["other@ingest.realadvisor.com"],
					permissions: ["conversations:manage"],
				},
				"POST",
				path,
			),
			false,
		);
	});
});
