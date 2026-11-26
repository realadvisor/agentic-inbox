/**
 * Structured failure lines for stored Worker logs. They must never hold mail
 * content, headers, query strings, addresses, tokens or other values: only
 * the event, the path (addresses and ids removed), method, status, timing and
 * the error's class and code. A driver message is kept only for database
 * errors (a Postgres SQLSTATE code), with quoted values removed.
 */
const started = new WeakMap<Request, number>();

export function markStart(request: Request) {
	started.set(request, Date.now());
}

/** Keep the shape of a driver message, drop any value it quotes or names. */
export function redactMessage(message: string) {
	return message
		.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "…")
		.replace(/\([^)]*\)=\([^)]*\)/g, "…")
		.replace(/https?:\/\/\S+/g, "…")
		.replace(/\S+@\S+/g, "…")
		.replace(/[A-Za-z0-9_\-.+/=]{20,}/g, "…")
		.slice(0, 200);
}

/** The request path with every segment that may name someone or something replaced. */
export function redactPath(pathname: string) {
	return pathname
		.split("/")
		.map((segment) => {
			let value = segment;
			try {
				value = decodeURIComponent(segment);
			} catch {
				return "…";
			}
			return value === "" || /^[a-z][a-z0-9-]*$/.test(value) ? value : "…";
		})
		.join("/")
		.slice(0, 200);
}

/** The error's class and code; its message only for a database error. */
export function errorFields(error: unknown) {
	const code =
		error && typeof error === "object" && "code" in error
			? (error as { code: unknown }).code
			: undefined;
	const database = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code);
	return {
		error: error instanceof Error ? error.name : typeof error,
		code: database ? code : null,
		message:
			database && error instanceof Error ? redactMessage(error.message) : null,
	};
}

export function failureLine<F extends Record<string, string | number | null>>(
	event: string,
	error: unknown,
	fields: F = {} as F,
) {
	return { event, ...fields, ...errorFields(error) };
}

export function requestFailure(
	error: unknown,
	request: Request,
	path: string,
	now = Date.now(),
) {
	const start = started.get(request);
	return failureLine("inbox_request_failed", error, {
		method: request.method,
		path,
		status: 500,
		duration_ms: start === undefined ? null : now - start,
	});
}

export function logFailure(
	event: string,
	error: unknown,
	fields?: Record<string, string | number | null>,
) {
	console.error(JSON.stringify(failureLine(event, error, fields)));
}

/**
 * Runs a Worker handler. A failure is logged as a redacted line and rethrown
 * as a plain error without the original message, so the platform still sees
 * the failure (and retries where it does) but stores no mail-derived text.
 */
export async function guarded<T>(event: string, run: () => Promise<T>) {
	try {
		return await run();
	} catch (error) {
		logFailure(event, error);
		throw new Error(`${event}: see the redacted log line`);
	}
}

/** For waitUntil: a rejected background task is logged redacted, not thrown. */
export function background(event: string, task: Promise<unknown>) {
	return task.then(
		() => undefined,
		(error: unknown) => logFailure(event, error),
	);
}
