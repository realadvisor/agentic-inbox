/** One active intent per mailbox plus confirmed composition receipts, scoped to a tab. */
interface SendIntent {
	scope: string;
	/** Scopes attached by unchanged retries after a panel remount. */
	scopes?: string[];
	key: string;
	url: string;
	body: string;
	confirmed: boolean;
}
type Journal = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Transport = (url: string, body: string, key: string) => Promise<void>;
const prefix = "inbox-send-intent:v1:";

export class SendIntents {
	private inFlight = new Map<string, Promise<void>>();
	constructor(
		private storage: () => Journal,
		private transport: Transport,
		private confirmRecovery: (message: string) => boolean,
		private definitelyRejected: (error: unknown) => boolean = () => false,
		// Server proof for this exact key, after checking its persisted attempts.
		private keyWasNeverSubmitted: (
			error: unknown,
			key: string,
		) => boolean = () => false,
	) {}

	async send(
		mailbox: string,
		scope: string,
		url: string,
		payload: unknown,
	): Promise<void> {
		if (!scope) throw new Error("A send composition identity is required.");
		const body = JSON.stringify(payload);
		const journal = this.storage(); // Fail closed if browser storage is unavailable.
		const slot = prefix + mailbox;
		const completedSlot = slot + ":completed:" + scope;
		const completed = journal.getItem(completedSlot);
		if (completed) {
			const sent = JSON.parse(completed) as { url: string; body: string };
			if (sent.url !== url || sent.body !== body)
				throw new Error(
					"This composition was already sent. Review Sent and start a new composition to send different content.",
				);
			return;
		}
		const raw = journal.getItem(slot);
		let intent: SendIntent | undefined =
			raw !== null ? JSON.parse(raw) : undefined;
		if (
			raw !== null &&
			(!intent ||
				typeof intent.key !== "string" ||
				typeof intent.body !== "string" ||
				typeof intent.url !== "string" ||
				typeof intent.scope !== "string" ||
				typeof intent.confirmed !== "boolean" ||
				(intent.scopes !== undefined &&
					(!Array.isArray(intent.scopes) ||
						!intent.scopes.includes(intent.scope) ||
						intent.scopes.some(
							(scope) => typeof scope !== "string" || !scope,
						))))
		) {
			throw new Error(
				"Cannot read saved send intent. Check Sent before clearing browser data.",
			);
		}
		if (
			intent &&
			!intent.confirmed &&
			(intent.url !== url || intent.body !== body)
		) {
			if (this.inFlight.has(slot))
				throw new Error(
					"A message is still being submitted. Wait before changing content.",
				);
			const previous = JSON.parse(intent.body) as {
				subject?: string;
				to?: unknown;
			};
			if (
				this.confirmRecovery(
					`A previous send is unresolved: ${previous.subject || "(no subject)"} to ${JSON.stringify(previous.to)}. Check the original send using its saved request and original sender? This may submit the ORIGINAL content if it never reached the server. Your changed message will not be sent.`,
				)
			) {
				await this.submit(slot, intent, journal);
				throw new Error(
					"Previous message confirmed sent. Review Sent before submitting your changed message as a new composition.",
				);
			}
			throw new Error(
				"Previous send is unresolved. Retry the original content or check the saved request before sending changed content.",
			);
		}
		if (intent?.confirmed && intent.scope === scope) {
			if (intent.url !== url || intent.body !== body)
				throw new Error(
					"This composition was already sent. Review Sent and start a new composition to send different content.",
				);
			return;
		}
		const firstAttempt = !intent || intent.confirmed;
		if (!intent || intent.confirmed) {
			intent = { scope, key: crypto.randomUUID(), url, body, confirmed: false };
			journal.setItem(slot, JSON.stringify(intent));
		}
		// Persist every retry scope before I/O. A failed confirmation write must not
		// leave a remounted composition free to submit again with a fresh key.
		intent.scopes = [...new Set([...(intent.scopes ?? [intent.scope]), scope])];
		journal.setItem(slot, JSON.stringify(intent));
		await this.submit(slot, intent, journal, firstAttempt);
	}

	private submit(
		slot: string,
		intent: SendIntent,
		journal: Journal,
		firstAttempt = false,
	): Promise<void> {
		const running = this.inFlight.get(slot);
		if (running) return running;
		const promise = Promise.resolve()
			.then(async () => {
				await this.transport(intent.url, intent.body, intent.key);
				// Another identical submission may have attached a scope while I/O ran.
				const latest = JSON.parse(journal.getItem(slot)!) as SendIntent;
				for (const scope of latest.scopes ?? [latest.scope]) {
					journal.setItem(
						slot + ":completed:" + scope,
						JSON.stringify({ url: intent.url, body: intent.body }),
					);
				}
				// Confirm only after all receipts are durable; any failure leaves the
				// original key pending so another scope cannot overwrite recovery state.
				journal.setItem(slot, JSON.stringify({ ...latest, confirmed: true }));
			})
			.catch((error: unknown) => {
				// Only a first-attempt pre-send rejection can release the payload lock.
				// Generic later rejections cannot disprove earlier ambiguous acceptance.
				// Only explicit server proof for this exact key can release an old journal.
				if (
					(firstAttempt && this.definitelyRejected(error)) ||
					this.keyWasNeverSubmitted(error, intent.key)
				)
					journal.removeItem(slot);
				throw error;
			})
			.finally(() => this.inFlight.delete(slot));
		this.inFlight.set(slot, promise);
		return promise;
	}
}
