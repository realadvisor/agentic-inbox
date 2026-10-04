import { useQueryClient } from "@tanstack/react-query";
import { useDeleteEmail } from "~/queries/emails";
import { queryKeys } from "~/queries/keys";
import { useSyncExternalStore } from "react";
import { draftDelivery } from "~/lib/draft-delivery";

const listeners = new Set<() => void>();
export function notifyDraftDelivery() {
	for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
	listeners.add(listener);
	window.addEventListener("storage", listener);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", listener);
	};
}
export function useDraftDelivery(mailbox?: string, draft?: string) {
	return useSyncExternalStore(
		subscribe,
		() => (mailbox && draft ? draftDelivery.read(mailbox, draft) : null),
		() => null,
	);
}

export function useDraftCleanup() {
	const remove = useDeleteEmail();
	const qc = useQueryClient();
	return {
		isPending: remove.isPending,
		cleanup: async (mailboxId: string, draftId: string) => {
			try {
				const cleaned = await draftDelivery.cleanup(mailboxId, draftId, () =>
					remove.mutateAsync({ mailboxId, id: draftId }),
				);
				if (cleaned) {
					// Also refresh after a 404 from an already-completed deletion.
					void qc.invalidateQueries({ queryKey: ["emails", mailboxId] });
					void qc.invalidateQueries({
						queryKey: queryKeys.folders.list(mailboxId),
					});
				}
			} finally {
				notifyDraftDelivery();
			}
		},
	};
}
