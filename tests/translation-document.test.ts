import { test } from "node:test";
import assert from "node:assert/strict";
import { translationDocument } from "../server/agent/translation-document";

test("translation replaces only text spans and preserves original markup, styles, links and images", () => {
	const html =
		'<!doctype html><html><head><style>p{color:red}</style></head><body><table width="600"><tr><td style="padding:20px"><p>Hello <b>world</b> &amp; friends.</p><a href="https://example.test">Read more</a><img src="cid:logo" alt="Logo"><span hidden>hidden</span><span translate="no">Brand</span></td></tr></table></body></html>';
	const doc = translationDocument(html);
	assert.deepEqual(
		doc.segments.map((s) => s.text),
		["Hello ", "world", " & friends.", "Read more"],
	);
	const output = doc.apply(
		JSON.stringify({
			segments: [
				{ id: 0, text: "Bonjour" },
				{ id: 1, text: "monde" },
				{ id: 2, text: "& amis." },
				{ id: 3, text: "Lire la suite" },
			],
		}),
	);
	assert.equal(
		output.html,
		html
			.replace("Hello ", "Bonjour ")
			.replace("world", "monde")
			.replace(" &amp; friends.", " &amp; amis.")
			.replace("Read more", "Lire la suite"),
	);
});
test("model markup is escaped and missing, duplicate or unknown segments fail closed", () => {
	const doc = translationDocument("<p>Hello</p><p>World</p>");
	const good = [
		{ id: 0, text: "<img src=x onerror=alert(1)>" },
		{ id: 1, text: "& goodbye" },
	];
	assert.equal(
		doc.apply(JSON.stringify({ segments: good })).html,
		"<p>&lt;img src=x onerror=alert(1)&gt;</p><p>&amp; goodbye</p>",
	);
	for (const segments of [
		good.slice(0, 1),
		[good[0], good[0]],
		[good[0], { id: 3, text: "No" }],
		[good[0], { id: 1, text: "" }],
	])
		assert.throws(() => doc.apply(JSON.stringify({ segments })));
});
