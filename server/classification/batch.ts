/** Coalesce prepared requests while leaving each job's lease, validation and retry
 * handling independent. Every participant must call done, including skipped jobs. */
export function batchRequests(request: typeof fetch, participants: number) {
	type Pending = {
		url: Parameters<typeof fetch>[0];
		init: RequestInit;
		body: { model: string; state: unknown; questions: { match: unknown } };
		resolve: (response: Response) => void;
		reject: (error: unknown) => void;
	};
	const pending: Pending[] = [];
	const ready = new Set<number>();
	let started = false;
	async function send(group: Pending[]) {
		try {
			if (group.length === 1) {
				group[0].resolve(
					await request(group[0].url, {
						...group[0].init,
						signal: AbortSignal.timeout(20_000),
					}),
				);
				return;
			}
			const response = await request(group[0].url, {
				...group[0].init,
				body: JSON.stringify(payload(group)),
				signal: AbortSignal.timeout(20_000),
			});
			if (!response.ok) {
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
						answers: { match: value?.answers?.[`q${index}`] },
					}),
				),
			);
		} catch (error) {
			for (const item of group) item.reject(error);
		}
	}
	function payload(group: Pending[]) {
		return {
			model: group[0].body.model,
			state: group[0].body.state,
			questions: Object.fromEntries(
				group.map((item, index) => [`q${index}`, item.body.questions.match]),
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
					new TextEncoder().encode(JSON.stringify(payload([...group, item])))
						.length > 24000)
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
					pending.push({ url, init: init ?? {}, body, resolve, reject });
					done(index);
				});
			},
	};
}
