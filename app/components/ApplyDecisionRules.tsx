import { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo";
import { useQueryClient } from "@tanstack/react-query";
import { classifierRequest, type Classifier } from "~/services/classifiers";
type Page = {
	resolved: number;
	remaining: number;
	fingerprint: string;
	before: string;
	cursor: { mailbox: string; thread: string } | null;
};
export function ApplyDecisionRules({
	classifiers,
	disabled,
}: {
	classifiers: Classifier[];
	disabled: boolean;
}) {
	const client = useQueryClient();
	const [busy, setBusy] = useState(false),
		[preview, setPreview] = useState<Page | null>(null),
		[message, setMessage] = useState(""),
		[error, setError] = useState("");
	const abort = useRef<AbortController | null>(null);
	const signature = JSON.stringify(
		classifiers.map((c) => [c.id, c.revision, c.decision_rules, c.enabled]),
	);
	useEffect(() => {
		setPreview(null);
		setMessage("");
		return () => abort.current?.abort();
	}, [signature, disabled]);
	async function run(apply: boolean) {
		const controller = new AbortController();
		abort.current = controller;
		setBusy(true);
		setError("");
		let resolved = 0,
			remaining = 0;
		let page: Page | null = apply ? preview : null;
		let cursor: Page["cursor"] = null;
		try {
			do {
				page = await classifierRequest<Page>(
					"/reapply-rules",
					"POST",
					{
						classifier_ids: classifiers.map((c) => c.id),
						apply,
						...(page
							? { fingerprint: page.fingerprint, before: page.before }
							: {}),
						...(cursor ? { cursor } : {}),
					},
					controller.signal,
				);
				resolved += page.resolved;
				remaining += page.remaining;
				cursor = page.cursor;
				setMessage(
					`${apply ? "Applied to" : "Can resolve"} ${resolved} decisions · ${remaining} remain${cursor ? " · Checking more…" : ""}`,
				);
			} while (cursor);
			setPreview(
				apply ? null : { ...page!, resolved, remaining, cursor: null },
			);
		} catch (e) {
			if (controller.signal.aborted)
				setMessage(
					"Stopped. Completed batches are kept; preview again to check remaining reviews.",
				);
			else
				setError(
					`${apply ? `${resolved} decisions applied before stopping. ` : ""}${e instanceof Error ? e.message : "Unable to evaluate saved answers"}`,
				);
		} finally {
			setBusy(false);
			if (apply) await client.invalidateQueries();
		}
	}
	return (
		<section className="space-y-2 rounded-lg border border-kumo-line p-3">
			<h3 className="text-sm font-medium">Apply rules to pending reviews</h3>
			<p className="text-xs text-kumo-subtle">
				Use saved Jev answers across all mailboxes. No new Jev requests. Human
				decisions and accepted results stay unchanged. Counts are decisions, not
				individual tags.
			</p>
			{disabled && (
				<p className="text-xs text-kumo-subtle">
					Save your changes, then reopen this editor to preview the saved rules.
				</p>
			)}
			<div className="flex flex-wrap gap-2">
				<Button
					type="button"
					size="sm"
					variant="secondary"
					disabled={disabled || busy || !classifiers.length}
					onClick={() => run(false)}
				>
					Preview saved rules
				</Button>
				{preview && (
					<Button
						type="button"
						size="sm"
						disabled={disabled || busy || !preview.resolved}
						onClick={() => run(true)}
					>
						Apply to {preview.resolved} pending reviews
					</Button>
				)}
				{busy && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={() => abort.current?.abort()}
					>
						Stop
					</Button>
				)}
			</div>
			{message && (
				<p role="status" className="text-xs text-kumo-subtle">
					{message}
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-kumo-danger">
					{error}
				</p>
			)}
			<p className="text-xs text-kumo-subtle">
				Uncertain, unavailable, outdated or protected answers remain unchanged.
				Results are checked again when applying.
			</p>
		</section>
	);
}
