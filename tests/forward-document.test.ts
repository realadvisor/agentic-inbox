import { test } from "node:test";
import assert from "node:assert/strict";
import {
	forwardDocumentMarker,
	forwardNoteStart,
	forwardNoteEnd,
	splitForwardDocument,
} from "../app/lib/forward-document";

test("forward draft boundaries preserve the document across note edits and nested forwards", () => {
	const original = `<table><tr><td>${forwardNoteStart}older note${forwardNoteEnd}</td></tr></table>`;
	const html = `${forwardDocumentMarker}<html><head><style>table{color:red}</style></head><body class="email">${forwardNoteStart}<p>My note</p>${forwardNoteEnd}${original}</body></html>`;
	const parts = splitForwardDocument(html)!;
	assert.equal(parts.note, "<p>My note</p>");
	assert.equal(parts.before + parts.note + parts.after, html);
	const updated = parts.before + "<p>Edited</p>" + parts.after;
	assert.equal(splitForwardDocument(updated)?.note, "<p>Edited</p>");
	assert.ok(updated.includes(original));
	assert.equal(splitForwardDocument("<p>Legacy draft</p>"), undefined);
	assert.equal(
		splitForwardDocument(forwardDocumentMarker + forwardNoteStart),
		undefined,
	);
});
