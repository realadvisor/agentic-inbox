import { Button, Dialog, Select } from "@cloudflare/kumo";
import { SparkleIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { classifierRequest } from "~/services/classifiers";
import type { ProviderRunPage } from "../../shared/provider-runs";
import { RunDetail } from "./ClassifierRunDetail";

export function ConversationClassifierDrawer({
	mailboxId,
	threadId,
}: {
	mailboxId: string;
	threadId: string;
}) {
	const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(
		null,
	);
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const runs = useInfiniteQuery({
		queryKey: ["conversation-provider-runs", mailboxId, threadId],
		enabled: open,
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) => {
			const query = new URLSearchParams({
				mailbox: mailboxId,
				thread: threadId,
			});
			if (pageParam) query.set("cursor", pageParam);
			return classifierRequest<ProviderRunPage>("/provider-runs?" + query);
		},
		getNextPageParam: (page) => page.next_cursor ?? undefined,
	});
	const history = runs.data?.pages.flatMap((p) => p.runs) ?? [];
	const active = selected ?? "all";
	const seen = new Set<string>();
	const latest = history.flatMap((run) => {
		const classifierIds = run.classifiers
			.map((c) => c.classifier_id)
			.filter((id) => !seen.has(id));
		for (const id of classifierIds) seen.add(id);
		return classifierIds.length ? [{ run, classifierIds }] : [];
	});
	const choices = history.map((run, index) => ({
		value: run.id,
		label: `${index === 0 ? "Latest · " : ""}${new Date(run.started_at).toLocaleString()} · ${run.status}`,
	}));
	return (
		<Dialog.Root
			open={open}
			onOpenChange={(value) => {
				setOpen(value);
				if (value) setSelected(null);
			}}
		>
			<Dialog.Trigger
				render={
					<button
						type="button"
						aria-label="View classifier runs"
						className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-kumo-line bg-kumo-base px-2.5 py-1.5 text-xs font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-kumo-brand cursor-pointer"
					/>
				}
			>
				<SparkleIcon size={15} aria-hidden="true" />
				<span>Classification</span>
				<CaretRightIcon size={12} aria-hidden="true" />
			</Dialog.Trigger>
			<Dialog
				className="flex flex-col"
				style={{
					zIndex: 50,
					top: 0,
					left: "auto",
					right: 0,
					bottom: 0,
					width: "min(560px, 100vw)",
					minWidth: 0,
					maxWidth: "100vw",
					height: "100dvh",
					translate: "none",
					transform: "none",
					scale: "1",
					borderRadius: 0,
				}}
			>
				<div className="flex items-center justify-between gap-3 border-b border-kumo-line px-5 py-4">
					<div>
						<Dialog.Title className="text-base font-semibold flex items-center gap-2">
							<SparkleIcon size={18} className="text-kumo-subtle" />
							Classification
						</Dialog.Title>
						<Dialog.Description className="text-xs text-kumo-subtle mt-1">
							Classifier activity for this conversation
						</Dialog.Description>
					</div>
					<Dialog.Close
						render={
							<Button
								variant="ghost"
								shape="square"
								aria-label="Close classification drawer"
							/>
						}
					>
						<XIcon size={18} />
					</Dialog.Close>
				</div>
				<div
					ref={setPortalContainer}
					className="min-h-0 overflow-y-auto flex-1"
				>
					{runs.isPending && (
						<p className="p-5 text-sm text-kumo-subtle" role="status">
							Loading latest run…
						</p>
					)}
					{runs.error && (
						<div className="p-5">
							<p role="alert" className="text-sm text-kumo-danger">
								{runs.error.message}
							</p>
							<Button
								variant="secondary"
								className="mt-3"
								onClick={() => void runs.refetch()}
							>
								Try again
							</Button>
						</div>
					)}
					{history.length > 1 && (
						<div className="px-5 pt-4 pb-3">
							<Select
								container={portalContainer}
								aria-label="Run history"
								className="w-full"
								value={active}
								items={[
									{ value: "all", label: "Latest results · all questions" },
									...choices,
								]}
								onValueChange={(value) => {
									if (value) setSelected(value);
								}}
							>
								<Select.Option value="all">
									Latest results · all questions
								</Select.Option>
								{choices.map((c) => (
									<Select.Option key={c.value} value={c.value}>
										{c.label}
									</Select.Option>
								))}
							</Select>
						</div>
					)}
					{active === "all" ? (
						<>
							{latest.length > 1 && (
								<p className="px-5 py-3 text-xs text-kumo-subtle">
									Latest results across {latest.length} requests. Each request
									has its own timestamp and full request/response.
								</p>
							)}
							{latest.map(({ run, classifierIds }) => (
								<RunDetail
									key={run.id}
									id={run.id}
									classifierIds={classifierIds}
									showConversationLink={false}
									className="border-b border-kumo-line"
								/>
							))}
						</>
					) : (
						<RunDetail key={active} id={active} showConversationLink={false} />
					)}
					{runs.data && !history.length && (
						<div className="px-5 py-10">
							<p className="font-medium text-sm">No classifier runs yet</p>
							<p className="mt-2 text-sm text-kumo-subtle">
								New classifier requests for this conversation will appear here.
								Older requests from before logging was enabled are unavailable.
							</p>
						</div>
					)}
					{runs.hasNextPage && (
						<div className="p-5">
							<Button
								variant="secondary"
								disabled={runs.isFetchingNextPage}
								onClick={() => void runs.fetchNextPage()}
							>
								{runs.isFetchingNextPage ? "Loading…" : "Load earlier runs"}
							</Button>
						</div>
					)}
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
