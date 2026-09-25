import {
	providerError,
	requestFits,
	withoutExamples,
} from "../../shared/jev-budget";
/** Coalesce prepared requests while leaving each job's lease, validation and retry
 * handling independent. Every participant must call done, including skipped jobs. */
export function batchRequests(
	request: typeof fetch,
	participants: number,
	transport?: (
		url: Parameters<typeof fetch>[0],
		init: RequestInit,
		indexes: number[],
		questionKeys?: string[],
	) => Promise<Response>,
) {
	type Pending = {
		index: number;
		url: Parameters<typeof fetch>[0];
		init: RequestInit;
		body: { model: string; state: unknown; questions: { match: unknown } };
		resolve: (response: Response) => void;
		reject: (error: unknown) => void;
	};
	// Include preparation time and leave 30 seconds for persistence before leases expire.
	const deadline = Date.now() + 60_000;
	const pending: Pending[] = [];
	const ready = new Set<number>();
	let started = false;
	async function send(group: Pending[]) {
		try {
			const remaining = deadline - Date.now();
			if (remaining <= 0)
				throw new Error("Batch delivery time budget exhausted");
			const sendRequest = (
				url: Parameters<typeof fetch>[0],
				init: RequestInit,
			) =>
				transport
					? transport(
							url,
							init,
							group.map((item) => item.index),
							questionKeys(group),
						)
					: request(url, init);
			const signal = AbortSignal.timeout(Math.min(20_000, remaining));

			const response = await sendRequest(group[0].url, {
				...group[0].init,
				body: JSON.stringify(payload(group)),
				signal,
			});
			if (!response.ok) {
				const error = providerError(
					response.status,
					await response
						.clone()
						.json()
						.catch(() => null),
				);
				if (
					error === "provider_context_limit" &&
					new Set(questionKeys(group)).size > 1
				) {
					// Split distinct questions only; Choice siblings share one question.
					const parts = new Map<string, Pending[]>();
					questionKeys(group).forEach((key, i) =>
						parts.set(key, [...(parts.get(key) ?? []), group[i]]),
					);
					for (const part of parts.values()) await send(part);
					return;
				}
				if (error === "provider_context_limit") {
					const smaller = group.map((item) => ({
						...item,
						body: {
							...item.body,
							questions: { match: withoutExamples(item.body.questions.match) },
						},
					}));
					if (
						JSON.stringify(payload(smaller)) !== JSON.stringify(payload(group))
					) {
						await send(smaller);
						return;
					}
				}
				for (const item of group) item.resolve(response.clone());
				return;
			}
			const value = (await response.json()) as {
				model?: string;
				answers?: Record<string, unknown>;
			};
			group.forEach((item, index) =>
				item.resolve(
					Response.json({
						model: value?.model,
						answers: { match: value?.answers?.[questionKeys(group)[index]] },
					}),
				),
			);
		} catch (error) {
			for (const item of group) item.reject(error);
		}
	}
	function questionKeys(group: Pending[]) {
		const seen = new Map<string, string>();
		return group.map((item, index) => {
			const q = item.body.questions.match as { type?: string };
			const signature = JSON.stringify(q);
			const key = group.length === 1 ? "match" : `q${index}`;
			if (q.type !== "choice") return key;
			const existing = seen.get(signature);
			if (existing) return existing;
			seen.set(signature, key);
			return key;
		});
	}
	function payload(group: Pending[]) {
		const keys = questionKeys(group);
		return {
			model: group[0].body.model,
			state: group[0].body.state,
			questions: Object.fromEntries(
				group.map((item, i) => [keys[i], item.body.questions.match]),
			),
		};
	}

	async function flush() {
		let group: Pending[] = [];
		for (const item of pending) {
			// A new message may arrive during preparation. Never combine different
			// conversation snapshots, even when the thread id matches.
			if (
				group.length &&
				(JSON.stringify(group[0].body.state) !==
					JSON.stringify(item.body.state) ||
					group[0].body.model !== item.body.model ||
					!requestFits(item.body.state, payload([...group, item]).questions))
			) {
				await send(group);
				group = [];
			}
			group.push(item);
		}
		if (group.length) await send(group);
	}
	function done(index: number) {
		ready.add(index);
		if (!started && ready.size === participants) {
			started = true;
			void flush().catch((error) => {
				for (const item of pending) item.reject(error);
			});
		}
	}
	return {
		done,
		forJob:
			(index: number): typeof fetch =>
			async (url, init) => {
				const body = JSON.parse(init?.body as string) as Pending["body"];
				return new Promise<Response>((resolve, reject) => {
					pending.push({ index, url, init: init ?? {}, body, resolve, reject });
					done(index);
				});
			},
	};
}
