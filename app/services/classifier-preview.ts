export interface PreviewRun {
	id: string;
	status: string;
	total: number;
	processed: number;
	skipped: number;
	review: number;
}
export interface PreviewClassifier {
	id: string;
	tag_id: string;
	name: string;
	color: string;
	question: string;
	mailbox_ids: string[];
	enabled: boolean;
	revision: number;
	run: PreviewRun | null;
}
export interface PreviewResult {
	mailbox_id: string;
	thread_id: string;
	classifier_id: string;
	revision: number;
	answer: boolean | null;
	source: string;
	question: string;
	name: string;
	color: string;
	tag_id: string;
}
export async function previewRequest<T>(
	path: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	const response = await fetch("/api/preview" + path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error || "Preview request failed");
	}
	return response.status === 204 ? (undefined as T) : response.json();
}
