import api from "./api";
let config: ReturnType<typeof api.getConfig> | undefined;
export interface ClassifierRun {
	id: string;
	status: string;
	total: number;
	processed: number;
	skipped: number;
	review: number;
	failed?: number;
}
export interface Classifier {
	id: string;
	tag_id: string;
	name: string;
	color: string;
	question: string;
	mailbox_ids: string[];
	enabled: boolean;
	revision: number;
	run: ClassifierRun | null;
	errors?: number;
}
export interface Classification {
	mailbox_id: string;
	thread_id: string;
	classifier_id: string;
	revision: number;
	answer: boolean | null;
	token?: string;
	status?: string;
	error?: string;
	source: string;
	question: string;
	name: string;
	color: string;
	tag_id: string;
}
export async function classifierRequest<T>(
	path: string,
	method = "GET",
	body?: unknown,
): Promise<T> {
	config ??= api.getConfig().catch((error) => {
		config = undefined;
		throw error;
	});
	const mode = await config;
	const response = await fetch(
		(mode.classifierPreview ? "/api/preview" : "/api/v1/classification") + path,
		{
			method,
			headers: { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		},
	);
	if (!response.ok) {
		const error = await response.json();
		throw new Error(error.error || "Classifier request failed");
	}
	return response.status === 204 ? (undefined as T) : response.json();
}
