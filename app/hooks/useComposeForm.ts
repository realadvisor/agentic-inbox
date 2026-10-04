// Modified for the RealAdvisor local Postgres prototype.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
	buildQuotedReplyBlock,
	escapeHtml,
	formatComposeDate,
	getSignatureBlock,
	htmlToPlainText,
	splitEmailList,
	stripHtml,
	toEmailListValue,
} from "~/lib/utils";
import {
	useDeleteEmail,
	useForwardEmail,
	useReplyToEmail,
	useSaveDraft,
	useSendEmail,
} from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { useSenders } from "~/queries/senders";
import { resolveSenderId, type SenderIdentity } from "shared/senders";
import { useUIStore } from "~/hooks/useUIStore";
import { buildReplyAllFields, getReplyAddress } from "~/lib/replies";

interface ComposeFormFields {
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
	original: NonNullable<
		ReturnType<typeof useUIStore.getState>["composeOptions"]["originalEmail"]
	>,
	sigBlock: string,
) {
	const safeSender = escapeHtml(original.sender);
	const safeSubject = escapeHtml(original.subject);
	const safeBody = escapeHtml(stripHtml(original.body || "")).replace(
		/\n/g,
		"<br>",
	);

	return `<p><br></p>${
		sigBlock ? `${sigBlock}<br>` : ""
	}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><strong>Forwarded message:</strong><br><strong>From:</strong> ${safeSender}<br><strong>Date:</strong> ${formatComposeDate(
		original.date,
	)}<br><strong>Subject:</strong> ${safeSubject}<br><br>${safeBody}</div>`;
}

function buildInitialComposeFields(
	composeOptions: ReturnType<typeof useUIStore.getState>["composeOptions"],
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

export function useComposeForm(
	mailboxId?: string,
	_folder?: string,
	separateQuote = false,
) {
	const toastManager = useKumoToastManager();
	const { composeOptions, closePanel, closeCompose } = useUIStore();
	const { data: currentMailbox } = useMailbox(mailboxId);
	const { data: senderConfig, error: senderLoadError } = useSenders();
	const [senderIdentityId, setSenderIdentityId] = useState("");
	const selectedSender = senderConfig?.senders.find(
		(s) => s.id === senderIdentityId,
	);
	const sendEmailMutation = useSendEmail();
	const saveDraftMutation = useSaveDraft();
	const replyMutation = useReplyToEmail();
	const forwardMutation = useForwardEmail();
	const deleteEmailMutation = useDeleteEmail();

	const [to, setTo] = useState("");
	const [cc, setCc] = useState("");
	const [bcc, setBcc] = useState("");
	const [showCcBcc, setShowCcBcc] = useState(false);
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");
	const [quotedBody, setQuotedBody] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSavingDraft, setIsSavingDraft] = useState(false);
	const [isSending, setIsSending] = useState(false);
	const lastInitializedOptionsRef = useRef<typeof composeOptions | null>(null);
	const [draftVersion, setDraftVersion] = useState<string | undefined>();
	const [savedDraftId, setSavedDraftId] = useState<string>();
	const isDraftEdit = !!composeOptions.draftEmail;

	const formTitle = useMemo(() => {
		if (isDraftEdit) return "Edit Draft";
		switch (composeOptions.mode) {
			case "reply":
				return "Reply";
			case "reply-all":
				return "Reply All";
			case "forward":
				return "Forward";
			default:
				return "New Message";
		}
	}, [composeOptions.mode, isDraftEdit]);

	const changeSender = (id: string) => {
		const previous = getSignatureBlock(selectedSender?.settings);
		const next = getSignatureBlock(
			senderConfig?.senders.find((s) => s.id === id)?.settings,
		);
		setBody((value) =>
			previous && value.includes(previous)
				? value.replace(previous, next)
				: next
					? `${value}${next}`
					: value,
		);
		setSenderIdentityId(id);
	};

	useEffect(() => {
		if (
			!senderConfig ||
			!currentMailbox ||
			lastInitializedOptionsRef.current === composeOptions
		)
			return;
		lastInitializedOptionsRef.current = composeOptions;
		setSavedDraftId(composeOptions.draftEmail?.id);
		const initialSenderId =
			resolveSenderId(senderConfig, {
				draft: composeOptions.draftEmail?.sender_identity_id,
				reply: ["reply", "reply-all"].includes(composeOptions.mode)
					? (composeOptions.originalEmail ?? undefined)
					: undefined,
				mailboxId: currentMailbox.id,
			}) ?? "";
		setSenderIdentityId(initialSenderId);
		const sigBlock = getSignatureBlock(
			senderConfig.senders.find((s) => s.id === initialSenderId)?.settings,
		);
		setDraftVersion(composeOptions.draftEmail?.draft_version ?? undefined);

		const initialFields = buildInitialComposeFields(
			composeOptions,
			currentMailbox?.email,
			sigBlock,
			senderConfig.senders,
		);
		setError(null);
		setTo(initialFields.to);
		setCc(initialFields.cc);
		setBcc(initialFields.bcc);
		setShowCcBcc(initialFields.showCcBcc);
		setSubject(initialFields.subject);
		const quoteIndex = separateQuote
			? initialFields.body.indexOf(
					'<br><blockquote style="border-left: 2px solid #ccc;',
				)
			: -1;
		setBody(
			quoteIndex >= 0
				? initialFields.body.slice(0, quoteIndex)
				: initialFields.body,
		);
		setQuotedBody(quoteIndex >= 0 ? initialFields.body.slice(quoteIndex) : "");
	}, [composeOptions, currentMailbox, senderConfig, separateQuote]);

	const handleSaveDraft = async () => {
		if (!mailboxId || isSending || isSavingDraft) return;
		if (!senderIdentityId) {
			setError("Choose a sender before saving.");
			return;
		}
		setIsSavingDraft(true);
		setError(null);
		try {
			const saved = await saveDraftMutation.mutateAsync({
				mailboxId,
				draft: {
					sender_identity_id: senderIdentityId,
					to,
					cc: cc || undefined,
					bcc: bcc || undefined,
					subject,
					body: body + quotedBody,
					in_reply_to:
						composeOptions.originalEmail?.id ||
						composeOptions.draftEmail?.in_reply_to ||
						undefined,
					thread_id:
						composeOptions.originalEmail?.thread_id ||
						composeOptions.draftEmail?.thread_id ||
						undefined,
					draft_id: savedDraftId,
					draft_version: draftVersion,
				},
			});
			setSavedDraftId(saved.draft_id);
			setDraftVersion(saved.draft_version);
			toastManager.add({ title: "Draft saved!" });
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) || "Failed to save draft.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		} finally {
			setIsSavingDraft(false);
		}
	};

	const handleSend = async (e: FormEvent, onClose: () => void) => {
		e.preventDefault();
		if (isSending) return;
		setError(null);
		if (
			!currentMailbox ||
			!mailboxId ||
			!selectedSender?.active ||
			!selectedSender.mailbox_id
		) {
			setError("Choose an available sender.");
			return;
		}
		const toRecipients = splitEmailList(to);
		if (toRecipients.length === 0) {
			setError("Add at least one recipient.");
			return;
		}
		const ccRecipients = splitEmailList(cc);
		const bccRecipients = splitEmailList(bcc);
		const emailData = {
			to: toEmailListValue(toRecipients),
			cc: toEmailListValue(ccRecipients),
			bcc: toEmailListValue(bccRecipients),
			sender_identity_id: senderIdentityId,
			draft_id: savedDraftId,
			subject,
			html: body + quotedBody,
			text: htmlToPlainText(body + quotedBody),
		};
		const draftId = savedDraftId;
		const sendScope = draftId || composeOptions.sendScope!;
		const mode = composeOptions.mode;
		const originalId =
			composeOptions.originalEmail?.id ||
			composeOptions.draftEmail?.in_reply_to;
		setIsSending(true);
		toastManager.add({ title: "Submitting message…" });
		try {
			if ((mode === "reply" || mode === "reply-all") && originalId)
				await replyMutation.mutateAsync({
					mailboxId,
					emailId: originalId,
					email: emailData,
					sendScope,
				});
			else if (mode === "forward" && originalId)
				await forwardMutation.mutateAsync({
					mailboxId,
					emailId: originalId,
					email: emailData,
					sendScope,
				});
			else
				await sendEmailMutation.mutateAsync({
					mailboxId,
					email: emailData,
					sendScope,
				});
			if (draftId)
				await deleteEmailMutation.mutateAsync({ mailboxId, id: draftId });
			toastManager.add({ title: "Message submitted" });
			onClose();
		} catch (err: unknown) {
			const message =
				(err instanceof Error ? err.message : null) || "Failed to send email.";
			setError(message);
			toastManager.add({ title: message, variant: "error" });
		} finally {
			setIsSending(false);
		}
	};

	return {
		senderConfig,
		senderIdentityId,
		changeSender,
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		quotedBody,
		quotedText: htmlToPlainText(quotedBody),
		error: error ?? senderLoadError?.message ?? null,
		setError,
		isSavingDraft,
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
		closeCompose,
		closePanel,
	};
}
