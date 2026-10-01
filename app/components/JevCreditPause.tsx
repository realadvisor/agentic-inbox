import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@cloudflare/kumo";
import { classifierRequest } from "~/services/classifiers";
import { classificationError } from "../../shared/jev-budget";
export interface JevProviderState {
	paused: boolean;
	paused_at: string | null;
	checking: boolean;
	resume_error: string | null;
}
export function useJevProviderState(enabled = true) {
	return useQuery({
		queryKey: ["jev-provider-state"],
		queryFn: () => classifierRequest<JevProviderState>("/provider-state"),
		enabled,
		refetchInterval: 5000,
	});
}
export function JevCreditPause({ state }: { state?: JevProviderState }) {
	const qc = useQueryClient();
	const resume = useMutation({
		mutationFn: () =>
			classifierRequest<JevProviderState>("/provider-state/resume", "POST", {}),
		onSuccess: (data) => {
			qc.setQueryData(["jev-provider-state"], data);
			void qc.invalidateQueries({ queryKey: ["backfills"] });
		},
		onSettled: () => {
			void qc.invalidateQueries({ queryKey: ["jev-provider-state"] });
		},
	});
	if (!state?.paused) return null;
	const checking = state.checking || resume.isPending;
	return (
		<section
			aria-label="Jev processing paused"
			role="status"
			className="m-5 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
		>
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h3 className="font-semibold">Paused — Typesafe credits exhausted</h3>
					<p className="mt-1">
						Live emails and historical runs are saved and waiting. After adding
						credits, resume to check Jev and continue.
					</p>
				</div>
				<Button
					variant="primary"
					disabled={checking}
					onClick={() => resume.mutate()}
				>
					{checking ? "Checking credits…" : "Resume processing"}
				</Button>
			</div>
			{state.resume_error && state.resume_error !== "provider_http_402" && (
				<p className="mt-2">
					The check failed: {classificationError(state.resume_error)} Processing
					remains paused.
				</p>
			)}
			{resume.isSuccess && state.resume_error === "provider_http_402" && (
				<p className="mt-2">
					Typesafe still reports insufficient credits. Processing remains
					paused.
				</p>
			)}
			{resume.error && (
				<p role="alert" className="mt-2">
					{resume.error.message}
				</p>
			)}
		</section>
	);
}
