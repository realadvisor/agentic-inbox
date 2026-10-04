import type {
	MailListResponse,
	MessageDetail,
	SaveDraftInput,
	SendEmailInput,
} from "shared/mail";
// Modified for the RealAdvisor local Postgres prototype.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";
import type { Email } from "~/types";
import { queryKeys } from "./keys";

// ---------- Queries ----------

export function useEmails(
	mailboxId: string | undefined,
	params: Record<string, string>,
	options?: { enabled?: boolean; refetchInterval?: number },
) {
	const queryParams = {
		...params,
		view: "summary",
		...(params.folder ? { threaded: "true" } : {}),
	};

	return useQuery<MailListResponse>({
		queryKey: mailboxId
			? queryKeys.emails.list(mailboxId, queryParams)
			: ["emails", "_disabled"],
		queryFn: ({ signal }) =>
			api.listEmails(mailboxId!, queryParams, { signal }),
		enabled: !!mailboxId && (options?.enabled ?? true),
		refetchInterval: options?.refetchInterval,
	});
}

export function useEmail(
	mailboxId: string | undefined,
	emailId: string | undefined,
) {
	return useQuery<MessageDetail>({
		queryKey:
			mailboxId && emailId
				? queryKeys.emails.detail(mailboxId, emailId)
				: ["emails", "_disabled_detail"],
		queryFn: () => api.getEmail(mailboxId!, emailId!),
		enabled: !!mailboxId && !!emailId,
	});
}

export function useThreadReplies(
	mailboxId: string | undefined,
	threadId: string | undefined | null,
) {
	const qc = useQueryClient();

	return useQuery<MessageDetail[]>({
		queryKey:
			mailboxId && threadId
				? queryKeys.emails.thread(mailboxId, threadId)
				: ["emails", "_disabled_thread"],
		queryFn: async ({ signal }) => {
			// Single request returns all thread emails with full bodies +
			// attachments. Eliminates the previous N+1 pattern that fired
			// a separate getEmail call per thread message.
			const emails = await api.getThread(mailboxId!, threadId!, {
				signal,
			});

			// Populate individual email detail caches so clicking a thread
			// message in the panel doesn't re-fetch.
			for (const email of emails) {
				qc.setQueryData(queryKeys.emails.detail(mailboxId!, email.id), email);
			}

			return emails;
		},
		enabled: !!mailboxId && !!threadId,
	});
}

// ---------- Mutations ----------

/** Invalidate both the email list and folder counts after any email mutation. */
function useInvalidateEmailData() {
	const qc = useQueryClient();
	return (mailboxId: string) => {
		qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
		qc.invalidateQueries({ queryKey: ["thread-status", mailboxId] });
		qc.invalidateQueries({
			queryKey: queryKeys.folders.list(mailboxId),
		});
	};
}

export function useSendEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			email,
			sendScope,
		}: {
			mailboxId: string;
			email: SendEmailInput;
			sendScope: string;
		}) => api.sendEmail(mailboxId, email, sendScope),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useUpdateEmail() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			data,
		}: {
			mailboxId: string;
			id: string;
			data: unknown;
		}) => api.updateEmail(mailboxId, id, data),
		onMutate: async ({ mailboxId, id, data }) => {
			// Only target list queries (3rd key element is an object = params),
			// NOT detail queries (string = emailId) or thread queries.
			const isListQuery = (query: { queryKey: readonly unknown[] }) =>
				query.queryKey[0] === "emails" &&
				query.queryKey[1] === mailboxId &&
				typeof query.queryKey[2] === "object" &&
				query.queryKey[2] !== null;

			// Cancel in-flight list queries so they don't overwrite our optimistic update
			await qc.cancelQueries({
				queryKey: ["emails", mailboxId],
				predicate: isListQuery,
			});

			// Snapshot current email list caches for rollback
			const listQueries = qc.getQueriesData<{
				emails: Email[];
				totalCount: number;
			}>({
				queryKey: ["emails", mailboxId],
				predicate: isListQuery,
			});

			// Optimistically patch every cached email list that contains this email
			for (const [key, cached] of listQueries) {
				if (!cached?.emails) continue;
				qc.setQueryData(key, {
					...cached,
					emails: cached.emails.map((e) =>
						e.id === id ? { ...e, ...(data as Partial<Email>) } : e,
					),
				});
			}

			// Also patch the detail cache
			const detailKey = queryKeys.emails.detail(mailboxId, id);
			const prevDetail = qc.getQueryData<Email>(detailKey);
			if (prevDetail) {
				qc.setQueryData(detailKey, {
					...prevDetail,
					...(data as Partial<Email>),
				});
			}

			return { listQueries, prevDetail, detailKey };
		},
		onError: (_err, _vars, context) => {
			// Roll back optimistic updates on failure
			if (context?.listQueries) {
				for (const [key, cached] of context.listQueries) {
					qc.setQueryData(key, cached);
				}
			}
			if (context?.prevDetail) {
				qc.setQueryData(context.detailKey, context.prevDetail);
			}
		},
		onSettled: (_data, _err, { mailboxId }) => {
			// Always refetch to ensure server truth
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({ queryKey: ["thread-status", mailboxId] });
			qc.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		},
	});
}

export function useMarkThreadRead() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			mailboxId,
			threadId,
		}: {
			mailboxId: string;
			threadId: string;
		}) => api.markThreadRead(mailboxId, threadId),
		onSuccess: (_data, { mailboxId }) => {
			qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
			qc.invalidateQueries({ queryKey: ["thread-status", mailboxId] });
			qc.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		},
	});
}

export function useDeleteEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({ mailboxId, id }: { mailboxId: string; id: string }) =>
			api.deleteEmail(mailboxId, id),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useMoveEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			id,
			folderId,
		}: {
			mailboxId: string;
			id: string;
			folderId: string;
		}) => api.moveEmail(mailboxId, id, folderId),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useSaveDraft() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			draft,
		}: {
			mailboxId: string;
			draft: SaveDraftInput;
		}) => api.saveDraft(mailboxId, draft),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useReplyToEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			email,
			sendScope,
		}: {
			mailboxId: string;
			emailId: string;
			email: SendEmailInput;
			sendScope: string;
		}) => api.replyToEmail(mailboxId, emailId, email, sendScope),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}

export function useForwardEmail() {
	const invalidate = useInvalidateEmailData();
	return useMutation({
		mutationFn: ({
			mailboxId,
			emailId,
			email,
			sendScope,
		}: {
			mailboxId: string;
			emailId: string;
			email: SendEmailInput;
			sendScope: string;
		}) => api.forwardEmail(mailboxId, emailId, email, sendScope),
		onSuccess: (_data, { mailboxId }) => invalidate(mailboxId),
	});
}
