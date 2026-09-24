import type {
	ThreadWorkflow,
	ThreadState,
	StatusChange,
} from "shared/thread-status";
// Modified for the RealAdvisor local Postgres prototype.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email, Folder, Mailbox, Tag } from "~/types";
import type { TagGroup, TagGroupInput } from "../../shared/tag-groups";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(
	url: string,
	opts?: {
		params?: Record<string, string>;
		responseType?: string;
		signal?: AbortSignal;
	},
) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		headers: { "Idempotency-Key": crypto.randomUUID() },
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

// ---------- API client ----------

const api = {
	listTags: () => get<Tag[]>("/api/v1/tags"),
	listTagGroups: () => get<TagGroup[]>("/api/v1/tag-groups"),
	createTagGroup: (group: TagGroupInput) =>
		post<TagGroup>("/api/v1/tag-groups", group),
	updateTagGroup: (id: string, group: TagGroupInput) =>
		put<TagGroup>(`/api/v1/tag-groups/${id}`, group),
	createTag: (tag: Omit<Tag, "id">) => post<Tag>("/api/v1/tags", tag),
	updateTag: (id: string, tag: Omit<Tag, "id">) =>
		put<Tag>(`/api/v1/tags/${id}`, tag),
	deleteTagGroup: (group: { id: string; revision: number }) =>
		del<void>(
			`/api/v1/tag-groups/${group.id}?confirm=true&revision=${group.revision}`,
		),
	deleteTag: (id: string) => del<void>(`/api/v1/tags/${id}?confirm=true`),
	setConversationTags: (
		mailboxId: string,
		thread_ids: string[],
		tag_id: string,
		action: "add" | "remove",
	) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/tags/bulk`, {
			thread_ids,
			tag_id,
			action,
		}),

	testClassifier: (data: unknown) =>
		post<{
			available: boolean;
			results: {
				name: string;
				request: unknown;
				result?: {
					probability: number;
					answer: boolean | null;
					confidence?: number;
					choice?: string;
					probabilities?: Record<string, number>;
				};
				error?: string;
			}[];
		}>("/api/v1/classification/test", data),

	// Config
	getConfig: () =>
		get<{
			domains: string[];
			emailAddresses: string[];
			canCreateMailboxes: boolean;
			canDeleteMailboxes: boolean;
			mode: "live" | "synthetic";
			classifierPreview?: boolean;
			classifiersEnabled?: boolean;
			canManageClassifiers?: boolean;
		}>("/api/v1/config"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Emails
	listEmails: (
		mailboxId: string,
		params: Record<string, string>,
		opts?: { signal?: AbortSignal },
	) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, {
			params,
			signal: opts?.signal,
		}),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, {
			signal: opts?.signal,
		}),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, {
			folderId,
		}),
	getThread: (
		mailboxId: string,
		threadId: string,
		opts?: { signal?: AbortSignal },
	) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, {
			signal: opts?.signal,
		}),
	getThreadStatus: (mailboxId: string, threadId: string) =>
		get<ThreadWorkflow>(
			`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/status`,
		),
	updateThreadStatus: (
		mailboxId: string,
		threadId: string,
		input: StatusChange,
	) =>
		put<ThreadState>(
			`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/status`,
			input,
		),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`,
			{ responseType: "blob" },
		),
	saveDraft: (
		mailboxId: string,
		draft: {
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) =>
		post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`,
			email,
		),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, {
			params,
		}),
};

export default api;
