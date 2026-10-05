import {
	TranslateIcon,
	SpinnerGapIcon,
	ArrowCounterClockwiseIcon,
} from "@phosphor-icons/react";
import { Button } from "@cloudflare/kumo";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
	const queryClient = useQueryClient();
	const [language, setLanguage] = useState(preferredLanguage);
	const [showTranslation, setShowTranslation] = useState(false);
	const canTranslate =
		!!mailboxId && email.delivery_status !== "draft" && !!email.body?.trim();
	const translation = useQuery({
		queryKey: [
			"email-translation-html-v2",
			mailboxId,
			email.id,
			language,
			email.body,
		],
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
	const translated = showTranslation && !!translation.data;
	const loading = showTranslation && translation.isFetching;
	return (
		<div>
			{canTranslate && (
				<div
					className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-kumo-line/60 bg-kumo-tint/30 px-3 py-2 text-xs text-kumo-subtle"
					aria-label="Email translation"
				>
					<div className="flex items-center gap-2">
						<TranslateIcon size={16} aria-hidden="true" />
						<span>Translate to</span>
						<AppSelect
							label="Translation language"
							compact
							value={language}
							triggerClassName="!bg-transparent !shadow-none"
							options={Object.entries(translationLanguages).map(
								([value, label]) => ({ value, label }),
							)}
							onChange={(value) => {
								if (!isTranslationLanguage(value)) return;
								setLanguage(value);
								try {
									localStorage.setItem(preferenceKey, value);
								} catch {
									/* Optional preference. */
								}
							}}
						/>
					</div>
					{loading && (
						<span role="status" className="flex items-center gap-1.5">
							<SpinnerGapIcon
								size={14}
								className="animate-spin motion-reduce:animate-none"
							/>
							Translating…
						</span>
					)}
					{translated && !loading && <span role="status">AI translation</span>}
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="ml-auto !h-7 !text-xs"
						onClick={() => {
							if (loading) {
								void queryClient.cancelQueries({
									queryKey: [
										"email-translation-html-v2",
										mailboxId,
										email.id,
										language,
										email.body,
									],
									exact: true,
								});
								setShowTranslation(false);
							} else if (showTranslation && translation.isError) {
								void translation.refetch();
							} else setShowTranslation(!showTranslation);
						}}
						icon={
							translated ? <ArrowCounterClockwiseIcon size={14} /> : undefined
						}
					>
						{loading
							? "Cancel"
							: translated
								? "Show original"
								: showTranslation && translation.isError
									? "Retry translation"
									: "Translate"}
					</Button>
				</div>
			)}
			{showTranslation && translation.isError && (
				<div role="alert" className="mb-3 text-sm text-kumo-subtle">
					{translation.error instanceof Error
						? translation.error.message
						: "Translation failed."}{" "}
				</div>
			)}
			<div
				role="region"
				aria-label={translated ? "Translated email" : "Original email"}
				aria-busy={loading}
			>
				<EmailIframe
					autoSize
					body={rewriteInlineImages(
						translated ? translation.data!.html : email.body || "",
						mailboxId || "",
						email.id,
						email.attachments,
					)}
				/>
			</div>
		</div>
	);
}
