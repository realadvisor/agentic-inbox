import { sanitizeEmailDocument } from "./email-document";
import {
	forwardDocumentMarker,
	forwardNoteStart,
	forwardNoteEnd,
} from "./forward-document";
import type { ComposeOptions } from "../hooks/useUIStore";
import {
	resolveSenderId,
	type SenderIdentity,
	type SenderConfiguration,
} from "../../shared/senders";
import { buildQuotedReplyBlock, escapeHtml, formatComposeDate } from "./utils";
import { buildReplyAllFields, getReplyAddress } from "./replies";
export interface ComposeFormFields {
	to: string;
	cc: string;
	bcc: string;
	showCcBcc: boolean;
	subject: string;
	body: string;
}

const EMPTY_FIELDS: ComposeFormFields = {
	to: "",
	cc: "",
	bcc: "",
	showCcBcc: false,
	subject: "",
	body: "",
};

function getPrefixedSubject(subject: string, prefix: "Re" | "Fwd") {
	const expectedPrefix = `${prefix}: `;
	return subject.startsWith(expectedPrefix)
		? subject
		: `${expectedPrefix}${subject}`;
}

function buildForwardBody(
	original: NonNullable<ComposeOptions["originalEmail"]>,
	sigBlock: string,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const doc = sanitizeEmailDocument(original.body || "");
	const note = `<p><br></p>${sigBlock ? `${sigBlock}<br>` : ""}`;
	const header = `<div style="border-top:1px solid #ddd;padding:12px 0;margin:16px 0;font:14px Arial,sans-serif;color:#333"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(original.date)}<br><strong>Subject:</strong> ${safeSubject}</div>`;
	// Only the marked note enters the editor. Keep the original document and CSS intact.
	doc.body.insertAdjacentHTML(
		"afterbegin",
		`${forwardNoteStart}${note}${forwardNoteEnd}${header}`,
	);
	return `${forwardDocumentMarker}<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

export function buildInitialComposeFields(
	composeOptions: ComposeOptions,
	mailboxEmail: string | undefined,
	sigBlock: string,
	senders: readonly SenderIdentity[],
): ComposeFormFields {
	const { draftEmail: draft, originalEmail: original, mode } = composeOptions;

	if (draft) {
		return {
			to: draft.recipient || "",
			cc: draft.cc || "",
			bcc: draft.bcc || "",
			showCcBcc: Boolean(draft.cc || draft.bcc),
			subject: draft.subject || "",
			body: draft.body || "",
		};
	}

	if (!original) {
		return {
			...EMPTY_FIELDS,
			body: sigBlock ? `<p><br></p>${sigBlock}` : "",
		};
	}

	if (mode === "reply") {
		return {
			...EMPTY_FIELDS,
			to: getReplyAddress(original),
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${
				sigBlock ? `${sigBlock}<br>` : ""
			}${buildQuotedReplyBlock(
				original.date,
				original.sender,
				original.body || "",
			)}`,
		};
	}

	if (mode === "reply-all") {
		const recipients = buildReplyAllFields(original, mailboxEmail, senders);
		return {
			...EMPTY_FIELDS,
			...recipients,
			subject: getPrefixedSubject(original.subject, "Re"),
			body: `<p><br></p>${
				sigBlock ? `${sigBlock}<br>` : ""
			}${buildQuotedReplyBlock(
				original.date,
				original.sender,
				original.body || "",
			)}`,
		};
	}

	if (mode === "forward") {
		return {
			...EMPTY_FIELDS,
			subject: getPrefixedSubject(original.subject, "Fwd"),
			body: buildForwardBody(original, sigBlock),
		};
	}

	return {
		...EMPTY_FIELDS,
		body: sigBlock ? `<p><br></p>${sigBlock}` : "",
	};
}

export function resolveComposeSender(
	config: SenderConfiguration,
	options: ComposeOptions,
	mailboxId: string,
) {
	return resolveSenderId(config, {
		draft: options.draftEmail?.sender_identity_id,
		reply: ["reply", "reply-all"].includes(options.mode)
			? (options.originalEmail ?? undefined)
			: undefined,
		mailboxId,
	});
}
