import type { DecisionRules as Rules } from "../../shared/decision-rules";
import { JevExamples } from "./JevExamples";
import { JevEmailTest } from "./JevEmailTest";
import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import type { TagGroupInput } from "../../shared/tag-groups";
import { groupChoice, jevQuestion, jevRequest } from "../../shared/jev-request";
export function JevRequestPreview({
	questions,
	examples = false,
	selection,
	group,
	groupId,
}: {
	questions: {
		name: string;
		question: string;
		classifier_id?: string;
		decision_rules?: Partial<Rules>;
	}[];
	selection?: string;
	group?: TagGroupInput;
	groupId?: string;
	examples?: boolean;
}) {
	const [copied, setCopied] = useState("");
	const request = jevRequest(
		{
			our_mailbox: "<mailbox address>",
			evaluated_at: "<evaluation timestamp>",
			timezone: "UTC",
			messages: "<received and confirmed-sent conversation messages>",
		},
		group?.selection === "single"
			? { match: groupChoice(group) }
			: Object.fromEntries(
					questions.map((q, i) => [
						questions.length === 1 ? "match" : `q${i}`,
						jevQuestion(q.question),
					]),
				),
	);
	const json = JSON.stringify(request, null, 2);
	return (
		<section
			aria-label="Jev request preview"
			className="min-w-0 rounded-xl border border-kumo-line bg-kumo-tint lg:sticky lg:top-0 lg:self-start"
		>
			<div className="flex items-center justify-between gap-3 border-b border-kumo-line p-4">
				<div>
					<h3 className="text-sm font-semibold">Jev request</h3>
					<p className="mt-1 text-xs text-kumo-subtle">
						Live preview of your unsaved configuration
					</p>
				</div>
				<Button
					type="button"
					size="sm"
					variant="secondary"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(json);
							setCopied("Copied");
						} catch {
							setCopied("Could not copy");
						}
					}}
				>
					Copy JSON
				</Button>
			</div>
			<JevExamples group={group} groupId={groupId} questions={questions} />
			<JevEmailTest
				questions={questions}
				examples={examples}
				selection={selection}
				group={group}
				groupId={groupId}
			/>
			<details className="border-t border-kumo-line">
				<summary className="cursor-pointer p-4 text-xs font-medium">
					Full instructions
				</summary>
				<div className="space-y-4 px-4 pb-4">
					{Object.entries(request.questions).map(([key, question]) => (
						<div key={key}>
							<p className="text-xs font-medium mb-2">{key}</p>
							<div className="whitespace-pre-wrap break-words text-xs text-kumo-subtle">
								{question.instructions}
							</div>
						</div>
					))}
					<p className="text-xs text-kumo-subtle">
						Includes shared email-handling rules and your instructions. Selected
						teaching examples appear in the actual conversation request.
					</p>
				</div>
			</details>
			<details>
				<summary className="cursor-pointer p-4 text-xs font-medium">
					Request template
				</summary>
				<div className="space-y-2 px-4 py-3 text-xs text-kumo-subtle">
					<p>POST api.typesafe.ai/v1/systemone · jev-latest</p>
					<p>
						Request template — conversation content is substituted at runtime.
						Previewing does not call Jev or change tags.
					</p>
					{(examples || groupId || questions[0]?.classifier_id) && (
						<p>
							Compatible teaching examples are added at runtime and are not
							included in this template. Preview a conversation to see the full
							request.
						</p>
					)}
					<p>
						{group?.selection === "single"
							? `match → ${group.name}`
							: questions
									.map(
										(q, i) =>
											`${questions.length === 1 ? "match" : `q${i}`} → ${q.name || "Untitled"}`,
									)
									.join(" · ")}
					</p>
					<p>
						Single-selection groups use Choice; other tags use yes/no questions.
						Questions are batched per conversation. See Runs for requests
						actually sent.
					</p>
					{copied && <p role="status">{copied}</p>}
				</div>
				<pre
					aria-label="Jev request JSON"
					className="max-h-[55dvh] overflow-auto border-t border-kumo-line bg-kumo-base p-4 text-xs leading-relaxed whitespace-pre-wrap break-words"
				>
					{json}
				</pre>
			</details>
		</section>
	);
}
