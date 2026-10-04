import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppSelect } from "~/components/AppSelect";
import EmailIframe from "~/components/EmailIframe";
import { rewriteInlineImages } from "~/lib/utils";
import api from "~/services/api";
import type { Email } from "~/types";
import {
	browserTranslationLanguage,
	isTranslationLanguage,
	translationLanguages,
} from "shared/translation";

const preferenceKey = "inbox.translation-language";
function preferredLanguage() {
	try {
		const saved = localStorage.getItem(preferenceKey);
		if (saved && isTranslationLanguage(saved)) return saved;
	} catch {
		/* Translation still works when browser storage is unavailable. */
	}
	return browserTranslationLanguage(
		typeof navigator === "undefined" ? [] : navigator.languages,
	);
}

/** The original message stays authoritative for replies, source view and attachments. */
export default function MessageBody({
	email,
	mailboxId,
}: {
	email: Email;
	mailboxId?: string;
}) {
	return (
		<TranslationBody
			key={`${mailboxId}:${email.id}`}
			email={email}
			mailboxId={mailboxId}
		/>
	);
}
function TranslationBody({
	email,
	mailboxId,
}: {
	email: Email;
	mailboxId?: string;
}) {
	const [language, setLanguage] = useState(preferredLanguage);
	const [showTranslation, setShowTranslation] = useState(false);
	const canTranslate =
		!!mailboxId && email.delivery_status !== "draft" && !!email.body?.trim();
	const translation = useQuery({
		queryKey: ["email-translation", mailboxId, email.id, language, email.body],
		queryFn: ({ signal }) =>
			api.translateEmail(mailboxId!, email.id, language, signal),
		enabled: canTranslate && showTranslation,
		staleTime: Infinity,
		gcTime: 30 * 60 * 1000,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchOnMount: false,
	});
	return (
		<div>
			{canTranslate && (
				<div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-kumo-subtle">
					<button
						type="button"
						className="font-medium text-kumo-brand hover:underline focus-visible:outline focus-visible:outline-2"
						aria-pressed={showTranslation}
						onClick={() => setShowTranslation(!showTranslation)}
					>
						{showTranslation ? "See original" : "See translation"}
					</button>
					<AppSelect
						label="Translation language"
						compact
						value={language}
						options={Object.entries(translationLanguages).map(
							([value, label]) => ({ value, label }),
						)}
						onChange={(value) => {
							if (!isTranslationLanguage(value)) return;
							setLanguage(value);
							try {
								localStorage.setItem(preferenceKey, value);
							} catch {
								/* Optional preference only. */
							}
						}}
					/>
					{showTranslation && translation.isFetching && (
						<span role="status">Translating…</span>
					)}
					{showTranslation && translation.data && <span>AI translation</span>}
				</div>
			)}
			{showTranslation && translation.isError && (
				<div role="alert" className="mb-3 text-sm text-kumo-subtle">
					{translation.error instanceof Error
						? translation.error.message
						: "Translation failed."}{" "}
					<button
						type="button"
						className="text-kumo-brand underline"
						disabled={translation.isFetching}
						onClick={() => void translation.refetch()}
					>
						Retry translation
					</button>
				</div>
			)}
			{showTranslation && translation.data ? (
				<div
					role="region"
					aria-label="Translated email"
					lang={language}
					dir="auto"
					className="whitespace-pre-wrap break-words text-sm leading-relaxed text-kumo-default"
				>
					{translation.data.text}
				</div>
			) : (
				<EmailIframe
					autoSize
					body={rewriteInlineImages(
						email.body || "",
						mailboxId || "",
						email.id,
						email.attachments,
					)}
				/>
			)}
		</div>
	);
}
