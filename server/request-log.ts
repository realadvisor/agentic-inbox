/**
 * One structured line for a request that failed with an unexpected error.
 * Stored Worker logs keep it for diagnosis, so it must never hold mail
 * content, headers, query strings, addresses or other values: only the path
 * (addresses and ids removed), method, status, timing and the error's class
 * and code.
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
		.replace(/\S+@\S+/g, "…")
		.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
			"…",
		)
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

export function requestFailure(
	error: Error,
	request: Request,
	path: string,
	now = Date.now(),
) {
	const start = started.get(request);
	const code = (error as { code?: unknown }).code;
	return {
		event: "inbox_request_failed",
		method: request.method,
		path,
		status: 500,
		duration_ms: start === undefined ? null : now - start,
		error: error.name,
		code: typeof code === "string" ? code.slice(0, 16) : null,
		message: redactMessage(error.message),
	};
}
