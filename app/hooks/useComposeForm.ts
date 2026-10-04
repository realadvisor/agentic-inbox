import {
	buildInitialComposeFields,
	resolveComposeSender,
} from "~/lib/compose-fields";
import { useComposerSend } from "./useComposerSend";
import { draftDelivery } from "~/lib/draft-delivery";
import { useDraftDelivery } from "~/hooks/useDraftDelivery";
// Modified for the RealAdvisor local Postgres prototype.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useKumoToastManager } from "@cloudflare/kumo";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { getSignatureBlock, htmlToPlainText } from "~/lib/utils";
import { useSaveDraft } from "~/queries/emails";
import { useMailbox } from "~/queries/mailboxes";
import { useSenders } from "~/queries/senders";
import { useUIStore } from "~/hooks/useUIStore";

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
	const saveDraftMutation = useSaveDraft();
	const composerSend = useComposerSend();

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
	const deliveryId = savedDraftId || composeOptions.draftEmail?.id;
	const deliveryState = useDraftDelivery(mailboxId, deliveryId);
	const sendAttempted = useRef(false);
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
		sendAttempted.current = false;
		setSavedDraftId(composeOptions.draftEmail?.id);
		const initialSenderId =
			resolveComposeSender(senderConfig, composeOptions, currentMailbox.id) ??
			"";
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
		if (
			!mailboxId ||
			isSending ||
			isSavingDraft ||
			sendAttempted.current ||
			(deliveryId && draftDelivery.read(mailboxId, deliveryId))
		)
			return;
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
					draft_mode: composeOptions.mode,
					draft_source_id:
						composeOptions.originalEmail?.id ||
						composeOptions.draftEmail?.draft_source_id ||
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
		if (
			isSending ||
			isSavingDraft ||
			sendAttempted.current ||
			(mailboxId && deliveryId && draftDelivery.read(mailboxId, deliveryId))
		)
			return;
		setError(null);
		if (!currentMailbox || !mailboxId) {
			setError("Choose an available sender.");
			return;
		}
		sendAttempted.current = true;
		setIsSending(true);
		try {
			const outcome = await composerSend.submit({
				mailboxId,
				sendScope: savedDraftId || composeOptions.sendScope!,
				draftId: savedDraftId,
				mode: composeOptions.mode,
				sourceId:
					composeOptions.originalEmail?.id ||
					composeOptions.draftEmail?.draft_source_id ||
					undefined,
				sender: selectedSender,
				fields: { to, cc, bcc, subject, body: body + quotedBody },
			});
			if (outcome.status === "accepted") onClose();
		} catch (err) {
			sendAttempted.current = false;
			setError(err instanceof Error ? err.message : "Failed to send message.");
		} finally {
			setIsSending(false);
		}
	};

	return {
		senderConfig,
		senderIdentityId,
		changeSender,
		deliveryId,
		sendBlocked: !!deliveryState || sendAttempted.current,
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
