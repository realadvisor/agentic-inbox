import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeEmailCss } from "../app/lib/email-document";

test("keeps responsive layout rules and safe inline styles", () => {
	assert.equal(sanitizeEmailCss("padding: 12px; color: rgb(1, 2, 3)", true), "padding:12px;color:rgb(1,2,3)");
	assert.match(sanitizeEmailCss("@media(max-width:600px){td{padding:4px}}"), /@media/);
});

test("removes external CSS resources including escaped and alternate URL syntax", () => {
	for (const value of ["url(https://example.test/a)", "u\\72l(https://example.test/a)", "image-set('https://example.test/a' 1x)", "image-set(url(https://example.test/a) 1x)", "var(--image,url(https://example.test/a))"]) {
		assert.equal(sanitizeEmailCss(`background:${value};padding:4px`, true), "padding:4px");
	}
	assert.equal(sanitizeEmailCss("@import 'https://example.test/a';@font-face{font-family:test;src:url(https://example.test/b)}p{color:red}"), "p{color:red}");
});


test("preserves safe custom properties while rejecting resource values", () => {
	assert.equal(sanitizeEmailCss("--brand:#123456;color:var(--brand);--tracking:url(https://example.test)", true), "--brand:#123456;color:var(--brand)");
});
