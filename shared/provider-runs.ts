export interface ProviderRun {
	id: string;
	mailbox_id: string;
	thread_id: string;
	subject: string;
	started_at: string;
	finished_at: string | null;
	duration_ms: number | null;
	status: "running" | "succeeded" | "failed" | "interrupted";
	http_status: number | null;
	requested_model: string;
	returned_model: string | null;
	error: string | null;
	classifiers: { classifier_id: string; name: string; attempt: number }[];
}
export interface ProviderRunItem {
	question_key: string;
	classifier_id: string;
	classifier_name: string;
	question: string;
	revision: number;
	generation: number;
	job_token: string;
	attempt: number;
	probability: number | null;
	answer: boolean | null;
	disposition:
		"pending" | "applied" | "review" | "retry" | "discarded" | "failed";
	error: string | null;
}
export interface ProviderRunDetail extends Omit<ProviderRun, "classifiers"> {
	request_body: string;
	response_body: string | null;
	items: ProviderRunItem[];
	email: { id: string; folder_id: string } | null;
}
export interface ProviderRunPage {
	runs: ProviderRun[];
	next_cursor: string | null;
}
