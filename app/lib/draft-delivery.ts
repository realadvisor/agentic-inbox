export type DraftDeliveryState = "accepted" | "cleaned";

/** Cleanup receipts only, never request payloads or idempotency keys. The send
 * intent journal owns uncertain-delivery recovery. Keep accepted tombstones so
 * stale/reopened drafts cannot start a fresh send after cleanup. */
export class DraftDeliveryLedger {
	private memory = new Map<string, DraftDeliveryState>();
	private sending = new Set<string>();
	constructor(private storage: () => Pick<Storage, "getItem" | "setItem">) {}
	private key(mailbox: string, draft: string) {
		return `inbox:draft-delivery:${JSON.stringify([mailbox, draft])}`;
	}
	read(mailbox: string, draft: string): DraftDeliveryState | null {
		const key = this.key(mailbox, draft);
		let value: string | null = null;
		try {
			value = this.storage().getItem(key);
		} catch {
			/* use memory */
		}
		const local = this.memory.get(key);
		if (local === "cleaned" || value === "cleaned") return "cleaned";
		if (local === "accepted" || value === "accepted") return "accepted";
		return null;
	}
	private write(mailbox: string, draft: string, state: DraftDeliveryState) {
		const key = this.key(mailbox, draft);
		this.memory.set(key, state);
		this.storage().setItem(key, state);
	}
	async submit(mailbox: string, draft: string, send: () => Promise<unknown>) {
		const key = this.key(mailbox, draft);
		if (this.read(mailbox, draft) || this.sending.has(key)) return false;
		// Verify storage before delivery; no acceptance record exists yet.
		try {
			this.storage().setItem(key, "");
		} catch {
			throw new Error(
				"Cannot safely record delivery in this browser. Enable browser storage before sending.",
			);
		}
		this.sending.add(key);
		try {
			await send(); // Failure preserves the draft; never retry delivery here.
			try {
				this.write(mailbox, draft, "accepted");
			} catch {
				/* Acceptance is irrevocable even if storage becomes unavailable. */
			}
			return true;
		} finally {
			this.sending.delete(key);
		}
	}
	async cleanup(
		mailbox: string,
		draft: string,
		remove: () => Promise<unknown>,
	) {
		if (this.read(mailbox, draft) !== "accepted") return false;
		try {
			await remove();
		} catch (error) {
			// A previous cleanup may have succeeded with a lost response.
			if (!(
				error instanceof Error &&
				"status" in error &&
				error.status === 404
			))
				throw error;
		}
		try {
			this.write(mailbox, draft, "cleaned");
		} catch {
			/* The accepted receipt remains a safe fallback on refresh. */
		}
		return true;
	}
}

export const draftDelivery = new DraftDeliveryLedger(() => window.localStorage);
