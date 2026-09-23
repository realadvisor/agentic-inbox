// Modified for the RealAdvisor local Postgres prototype.
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { ClassifierReviewPreview } from "~/components/ClassifierReviewPreview";
import { useMailMode } from "~/components/MailMode";
import {
	previewRequest,
	type PreviewResult,
} from "~/services/classifier-preview";
import { TagActions, TagChips, TagPicker } from "~/components/ConversationTags";
import { useTags } from "~/queries/tags";
import { Button, Pagination, Tooltip } from "@cloudflare/kumo";
import {
	ArchiveIcon,
	ArrowBendUpLeftIcon,
	ArrowsClockwiseIcon,
	EnvelopeOpenIcon,
	EnvelopeSimpleIcon,
	FileIcon,
	PaperPlaneTiltIcon,
	PencilSimpleIcon,
	StarIcon,
	TrashIcon,
	TrayIcon,
} from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Folders } from "shared/folders";
import { formatListDate } from "shared/dates";
import MailboxSplitView from "~/components/MailboxSplitView";
import { getSnippetText } from "~/lib/utils";
import {
	useDeleteEmail,
	useEmails,
	useMarkThreadRead,
	useUpdateEmail,
} from "~/queries/emails";
import { useFolders } from "~/queries/folders";
import { queryKeys } from "~/queries/keys";
import { useUIStore } from "~/hooks/useUIStore";
import type { Email } from "~/types";

const PAGE_SIZE = 25;

const FOLDER_EMPTY_STATES: Record<
	string,
	{
		icon: React.ReactNode;
		title: string;
		description: string;
		showCompose?: boolean;
	}
> = {
	[Folders.INBOX]: {
		icon: <TrayIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Your inbox is empty",
		description:
			"New emails will appear here when they arrive. Send an email to get the conversation started.",
		showCompose: true,
	},
	[Folders.SENT]: {
		icon: (
			<PaperPlaneTiltIcon
				size={48}
				weight="thin"
				className="text-kumo-subtle"
			/>
		),
		title: "No sent emails",
		description: "Emails you send will show up here.",
		showCompose: true,
	},
	[Folders.DRAFT]: {
		icon: <FileIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "No drafts",
		description: "Emails you're still working on will be saved here.",
		showCompose: true,
	},
	[Folders.ARCHIVE]: {
		icon: <ArchiveIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Archive is empty",
		description:
			"Move emails here to keep your inbox clean without deleting them.",
	},
	[Folders.TRASH]: {
		icon: <TrashIcon size={48} weight="thin" className="text-kumo-subtle" />,
		title: "Trash is empty",
		description:
			"Deleted emails will appear here. You can restore them or permanently delete them.",
	},
};

function EmailListSkeleton() {
	return (
		<div className="animate-pulse space-y-1 p-2">
			{Array.from({ length: 8 }).map((_, i) => (
				<div key={i} className="flex items-center gap-3 px-3 py-3">
					<div className="w-4 h-4 rounded bg-kumo-fill" />
					<div className="w-5 h-5 rounded bg-kumo-fill" />
					<div className="flex-1 space-y-2">
						<div className="flex items-center gap-2">
							<div className="h-3 w-24 rounded bg-kumo-fill" />
							<div className="h-3 w-4 rounded bg-kumo-fill" />
							<div className="h-3 flex-1 rounded bg-kumo-fill" />
							<div className="h-3 w-12 rounded bg-kumo-fill" />
						</div>
						<div className="h-2.5 w-3/4 rounded bg-kumo-fill" />
					</div>
				</div>
			))}
		</div>
	);
}

function FolderEmptyState({
	folder,
	onCompose,
}: {
	folder?: string;
	onCompose: () => void;
}) {
	const config = (folder && FOLDER_EMPTY_STATES[folder]) || {
		icon: (
			<EnvelopeSimpleIcon
				size={48}
				weight="thin"
				className="text-kumo-subtle"
			/>
		),
		title: "No emails",
		description: "This folder is empty.",
	};

	return (
		<div className="flex flex-col items-center justify-center py-24 px-6 text-center">
			<div className="mb-4">{config.icon}</div>
			<h3 className="text-base font-semibold text-kumo-default mb-1.5">
				{config.title}
			</h3>
			<p className="text-sm text-kumo-subtle max-w-xs mb-5">
				{config.description}
			</p>
			{"showCompose" in config && config.showCompose && (
				<Button
					variant="primary"
					size="sm"
					icon={<PencilSimpleIcon size={16} />}
					onClick={onCompose}
				>
					Compose
				</Button>
			)}
		</div>
	);
}

export default function EmailListRoute() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;

		folder: string;
	}>();
	const mode = useMailMode();
	const previewResults = useQuery({
		queryKey: ["preview-results", mailboxId],
		queryFn: () =>
			previewRequest<PreviewResult[]>(
				"/results/" + encodeURIComponent(mailboxId!),
			),
		enabled: !!mode.data?.classifierPreview && !!mailboxId,
		refetchInterval: 2000,
	});

	const {
		selectedEmailId,
		isComposing,
		selectEmail,
		closePanel,
		startCompose,
	} = useUIStore();
	const [page, setPage] = useState(1);
	const [searchParams, setSearchParams] = useSearchParams();
	const tagId = searchParams.get("tag_id") ?? "";
	const setTagId = (id: string) =>
		setSearchParams((current) => {
			const next = new URLSearchParams(current);
			if (id) next.set("tag_id", id);
			else next.delete("tag_id");
			return next;
		});
	const viewKey = `${mailboxId}/${folder}/${tagId}`;
	const prevFolderRef = useRef<string | undefined>(undefined);
	const viewChanged = prevFolderRef.current !== viewKey;
	const currentPage = viewChanged ? 1 : page;
	const catalog = useTags();
	const [selectedThreads, setSelectedThreads] = useState<string[]>([]);
	useEffect(() => {
		setSelectedThreads([]);
	}, [mailboxId, folder, page, tagId]);

	const queryClient = useQueryClient();
	const updateEmail = useUpdateEmail();
	const markThreadRead = useMarkThreadRead();
	const deleteEmail = useDeleteEmail();

	const params = useMemo(
		() => ({
			folder: folder === "all" ? "" : folder || "",
			threaded: "true",
			page: String(currentPage),
			limit: String(PAGE_SIZE),
			...(tagId ? { tag_id: tagId } : {}),
		}),
		[folder, currentPage, tagId],
	);

	const { data: emailData, isFetching: isRefreshing } = useEmails(
		mailboxId,
		params,
		{ refetchInterval: 30_000 },
	);

	const emails = emailData?.emails ?? [];
	const totalCount = emailData?.totalCount ?? 0;

	const { data: folders = [] } = useFolders(mailboxId);

	const folderName = useMemo(() => {
		if (folder === "all")
			return tagId
				? (catalog.data?.find((tag) => tag.id === tagId)?.name ??
						"Tagged conversations")
				: "All conversations";
		const found = folders.find((f) => f.id === folder);
		if (found) return found.name;
		return folder ? folder.charAt(0).toUpperCase() + folder.slice(1) : "Inbox";
	}, [folders, folder, tagId, catalog.data]);

	const isPanelOpen = selectedEmailId !== null || isComposing;

	useEffect(() => {
		if (viewChanged) {
			prevFolderRef.current = viewKey;
			closePanel();
			setPage(1);
		}
	}, [viewChanged, viewKey, closePanel]);

	const toggleStar = (e: React.MouseEvent, email: Email) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId)
			updateEmail.mutate({
				mailboxId,
				id: email.id,
				data: { starred: !email.starred },
			});
	};

	const handleDelete = (e: React.MouseEvent, emailId: string) => {
		e.preventDefault();
		e.stopPropagation();
		if (mailboxId) {
			const confirmed = window.confirm(
				"Are you sure you want to delete this email?",
			);
			if (!confirmed) return;
			deleteEmail.mutate({ mailboxId, id: emailId });
			if (selectedEmailId === emailId) closePanel();
		}
	};

	const handleRefresh = () => {
		if (mailboxId) {
			queryClient.invalidateQueries({ queryKey: ["emails", mailboxId] });
			queryClient.invalidateQueries({
				queryKey: queryKeys.folders.list(mailboxId),
			});
		}
	};

	// Thread-aware helpers
	const hasUnread = (email: Email): boolean => {
		if (email.thread_unread_count !== undefined) {
			return email.thread_unread_count > 0;
		}
		return !email.read;
	};

	const handleRowClick = (email: Email) => {
		selectEmail(email.id);
		if (mailboxId && hasUnread(email)) {
			if (email.thread_id && email.thread_count && email.thread_count > 1) {
				markThreadRead.mutate({
					mailboxId,
					threadId: email.thread_id,
				});
			} else {
				updateEmail.mutate({
					mailboxId,
					id: email.id,
					data: { read: true },
				});
			}
		}
	};

	const formatParticipants = (email: Email): string => {
		if (email.participants) {
			const names = email.participants
				.split(",")
				.map((p) => p.trim().split("@")[0])
				.filter((name, idx, arr) => arr.indexOf(name) === idx);
			if (names.length <= 3) return names.join(", ");
			return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
		}
		return email.sender.split("@")[0];
	};

	return (
		<MailboxSplitView
			selectedEmailId={selectedEmailId}
			isComposing={isComposing}
		>
			{/* Folder header */}
			<div className="flex items-center justify-between px-4 py-3.5 border-b border-kumo-line shrink-0 md:px-5">
				<h1 className="text-lg font-semibold text-kumo-default">
					{folderName}
				</h1>
				<div className="flex items-center gap-1">
					{totalCount > 0 && (
						<span className="text-sm text-kumo-subtle mr-2 hidden sm:inline">
							{totalCount} conversation{totalCount !== 1 ? "s" : ""}
						</span>
					)}
					<Tooltip
						content={isRefreshing ? "Refreshing..." : "Refresh"}
						side="bottom"
						asChild
					>
						<Button
							variant="ghost"
							shape="square"
							size="sm"
							icon={
								<ArrowsClockwiseIcon
									size={18}
									className={isRefreshing ? "animate-spin" : ""}
								/>
							}
							onClick={handleRefresh}
							disabled={isRefreshing}
							aria-label="Refresh"
						/>
					</Tooltip>
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-kumo-line text-sm">
				<TagPicker
					tags={catalog.data ?? []}
					value={tagId}
					label="Tag filter"
					placeholder="Filter by tag"
					allowAll
					onChange={(id) => {
						setTagId(id);
						setPage(1);
					}}
				/>

				{catalog.error && <span role="alert">{catalog.error.message}</span>}
				{emails.length > 0 && (
					<label className="flex items-center gap-2">
						<input
							type="checkbox"
							aria-label="Select all conversations on page"
							checked={emails.every((email) =>
								selectedThreads.includes(email.thread_id ?? email.id),
							)}
							onChange={(e) =>
								setSelectedThreads(
									e.target.checked
										? [
												...new Set(
													emails.map((email) => email.thread_id ?? email.id),
												),
											]
										: [],
								)
							}
						/>
						Select page
					</label>
				)}
				{selectedThreads.length > 0 && mailboxId && (
					<>
						<span className="rounded-md bg-kumo-tint px-2 py-1 text-xs font-medium">
							{selectedThreads.length} selected
						</span>
						<TagActions
							bulk
							mailboxId={mailboxId}
							threadIds={selectedThreads}
						/>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setSelectedThreads([])}
						>
							Clear selection
						</Button>
					</>
				)}
			</div>

			{/* Email rows */}
			<div className="flex-1 overflow-y-auto">
				{isRefreshing && emails.length === 0 ? (
					<EmailListSkeleton />
				) : emails.length > 0 ? (
					<div>
						{emails.map((email) => {
							const isSelected = selectedEmailId === email.id;
							const snippet = getSnippetText(email.snippet);
							return (
								<div
									key={email.id}
									role="button"
									tabIndex={0}
									onClick={() => handleRowClick(email)}
									onKeyDown={(e) => {
										if (
											e.target === e.currentTarget &&
											(e.key === "Enter" || e.key === " ")
										) {
											e.preventDefault();
											handleRowClick(email);
										}
									}}
									className={`group flex items-center gap-3 w-full text-left cursor-pointer transition-colors border-b border-kumo-line px-4 py-2.5 md:px-6 md:py-3 ${
										isPanelOpen ? "md:px-4 md:py-2.5" : ""
									} ${isSelected ? "bg-kumo-tint" : "hover:bg-kumo-tint"}`}
								>
									<input
										type="checkbox"
										aria-label={`Select conversation ${email.subject}`}
										checked={selectedThreads.includes(
											email.thread_id ?? email.id,
										)}
										onClick={(e) => e.stopPropagation()}
										onChange={(e) => {
											const thread = email.thread_id ?? email.id;
											setSelectedThreads((current) =>
												e.target.checked
													? [...new Set([...current, thread])]
													: current.filter((id) => id !== thread),
											);
										}}
									/>
									{/* Unread dot */}
									<div className="w-2.5 shrink-0 flex justify-center">
										{hasUnread(email) && (
											<div className="h-2 w-2 rounded-full bg-kumo-brand" />
										)}
									</div>

									{/* Star */}
									<button
										type="button"
										className="shrink-0 p-0.5 bg-transparent border-0 cursor-pointer"
										onClick={(e) => {
											e.stopPropagation();
											toggleStar(e, email);
										}}
									>
										<StarIcon
											size={16}
											weight={email.starred ? "fill" : "regular"}
											className={
												email.starred
													? "text-kumo-warning"
													: "text-kumo-subtle hover:text-kumo-warning"
											}
										/>
									</button>

									{/* Content */}
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span
												className={`truncate text-sm ${
													hasUnread(email)
														? "font-semibold text-kumo-default"
														: "text-kumo-strong"
												}`}
											>
												{formatParticipants(email)}
											</span>
											{(email.thread_count ?? 1) > 1 && (
												<span className="shrink-0 text-xs text-kumo-subtle bg-kumo-fill rounded-full px-1.5 py-0.5 font-medium">
													{email.thread_count}
												</span>
											)}
											{email.has_draft && (
												<span className="shrink-0 text-xs text-kumo-destructive font-medium">
													Draft
												</span>
											)}
											{email.needs_reply && !email.has_draft && (
												<Tooltip content="Needs reply" asChild>
													<span className="shrink-0 text-kumo-warning">
														<ArrowBendUpLeftIcon size={14} weight="bold" />
													</span>
												</Tooltip>
											)}
											<span className="text-sm text-kumo-subtle shrink-0 ml-auto">
												{formatListDate(email.date)}
											</span>
										</div>
										<div className="truncate text-sm mt-0.5">
											<span
												className={
													hasUnread(email)
														? "font-medium text-kumo-default"
														: "text-kumo-subtle"
												}
											>
												{email.subject}
											</span>
											{snippet && (
												<span className="text-kumo-subtle font-normal">
													{" "}
													&mdash; {snippet}
												</span>
											)}
										</div>
										{mode.data?.classifierPreview && (
											<ClassifierReviewPreview
												results={(previewResults.data ?? []).filter(
													(r) => r.thread_id === email.thread_id,
												)}
											/>
										)}
										{!!email.tags?.length && (
											<div className="mt-1.5 flex">
												<TagChips tags={email.tags} />
											</div>
										)}
									</div>

									{/* Hover actions */}
									<div className="hidden group-hover:flex items-center shrink-0">
										<Tooltip
											content={email.read ? "Mark unread" : "Mark read"}
											asChild
										>
											<Button
												variant="ghost"
												shape="square"
												size="sm"
												icon={
													email.read ? (
														<EnvelopeSimpleIcon size={14} />
													) : (
														<EnvelopeOpenIcon size={14} />
													)
												}
												onClick={(e) => {
													e.stopPropagation();
													if (mailboxId)
														updateEmail.mutate({
															mailboxId,
															id: email.id,
															data: { read: !email.read },
														});
												}}
												aria-label={email.read ? "Mark unread" : "Mark read"}
											/>
										</Tooltip>
										<Tooltip content="Delete" asChild>
											<Button
												variant="ghost"
												shape="square"
												size="sm"
												icon={<TrashIcon size={14} />}
												onClick={(e) => handleDelete(e, email.id)}
												aria-label="Delete"
											/>
										</Tooltip>
									</div>
								</div>
							);
						})}
					</div>
				) : tagId ? (
					<p className="p-8 text-center text-kumo-subtle">
						{folder === "all"
							? "No conversations with this tag in this mailbox."
							: "No conversations with this tag in this folder."}
					</p>
				) : (
					<FolderEmptyState folder={folder} onCompose={() => startCompose()} />
				)}
			</div>

			{/* Pagination */}
			{totalCount > PAGE_SIZE && (
				<div className="flex justify-center py-3 border-t border-kumo-line shrink-0">
					<Pagination
						page={currentPage}
						setPage={setPage}
						perPage={PAGE_SIZE}
						totalCount={totalCount}
					/>
				</div>
			)}
		</MailboxSplitView>
	);
}
