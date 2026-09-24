import { useState } from "react";
import { getToolOrDynamicToolName, isToolOrDynamicToolUIPart } from "ai";
import {
	ArrowUpRightIcon,
	CaretRightIcon,
	CheckIcon,
	CircleNotchIcon,
	CopyIcon,
	EnvelopeSimpleIcon,
	FileTextIcon,
	MagnifyingGlassIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { InboxChatMessage } from "../../shared/agent";
import { draftIdFromOutput } from "../../shared/agent-messages";

const labels: Record<string, string> = {
	list_emails: "Read inbox",
	get_email: "Read email",
	get_thread: "Read conversation",
	search_emails: "Searched emails",
	draft_reply: "Drafted reply",
	draft_email: "Created draft",
	mark_email_read: "Updated read status",
	move_email: "Moved email",
	discard_draft: "Discarded draft",
};
function field(value: unknown, name: string) {
	if (value && typeof value === "object" && name in value) {
		const item = Reflect.get(value, name);
		if (typeof item === "string") return item;
	}
	return undefined;
}
export default function AgentMessage({
	message,
	modelName,
	onReview,
}: {
	message: InboxChatMessage;
	modelName: string;
	onReview: (id: string) => void;
}) {
	const [copied, setCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const user = message.role === "user";
	const text = message.parts
		.filter((p) => p.type === "text")
		.map((p) => p.text)
		.join("\n");
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
			setCopyError(false);
		} catch {
			setCopyError(true);
		}
	};
	return (
		<article
			className={`agent-message ${user ? "agent-message-user" : "agent-message-assistant"}`}
		>
			{message.parts.map((part, index) => {
				if (part.type === "text")
					return user ? (
						<p key={index}>{part.text}</p>
					) : (
						<div className="agent-markdown" key={index}>
							<Markdown
								remarkPlugins={[remarkGfm]}
								components={{
									a: ({ children, ...props }) => (
										<a {...props} target="_blank" rel="noopener noreferrer">
											{children}
										</a>
									),
								}}
							>
								{part.text}
							</Markdown>
						</div>
					);
				if (!isToolOrDynamicToolUIPart(part)) return null;
				const name = getToolOrDynamicToolName(part),
					failed = part.state === "output-error",
					done = part.state === "output-available";
				const draft = done ? draftIdFromOutput(part.output) : undefined;
				if (draft)
					return (
						<div className="agent-draft-card" key={part.toolCallId}>
							<div className="agent-draft-heading">
								<span className="agent-draft-icon">
									<EnvelopeSimpleIcon size={18} />
								</span>
								<div>
									<strong>Reply ready for review</strong>
									<span>Saved in Drafts</span>
								</div>
								<CheckIcon size={15} className="agent-success" />
							</div>
							<div className="agent-draft-body">
								<h4>{field(part.output, "subject") ?? "Email draft"}</h4>
								{field(part.input, "body") ? (
									<p>{field(part.input, "body")}</p>
								) : (
									<p className="agent-muted">
										Open this draft to read and edit your reply.
									</p>
								)}
							</div>
							<button
								type="button"
								className="agent-draft-action"
								onClick={() => onReview(draft)}
							>
								Review draft
								<ArrowUpRightIcon size={15} />
							</button>
						</div>
					);
				const Icon =
					name === "search_emails"
						? MagnifyingGlassIcon
						: name.startsWith("get_")
							? FileTextIcon
							: EnvelopeSimpleIcon;
				return (
					<details
						className={`agent-tool ${failed ? "agent-tool-error" : ""}`}
						key={part.toolCallId}
					>
						<summary>
							<Icon size={13} />
							<span>{labels[name] ?? name.replaceAll("_", " ")}</span>
							{failed ? (
								<WarningCircleIcon size={13} />
							) : done ? (
								<CheckIcon size={12} />
							) : (
								<CircleNotchIcon size={13} className="agent-spin" />
							)}
							<CaretRightIcon size={11} className="agent-tool-caret" />
						</summary>
						<div className="agent-tool-detail">
							{failed && <p role="alert">{part.errorText}</p>}
							<span>Request</span>
							<pre>{JSON.stringify(part.input, null, 2)}</pre>
							{done && (
								<>
									<span>Result</span>
									<pre>{JSON.stringify(part.output, null, 2)}</pre>
								</>
							)}
						</div>
					</details>
				);
			})}
			{!user && text && (
				<div className="agent-message-meta">
					<span>{modelName}</span>
					{message.metadata?.usage && (
						<span title="Estimated model cost at catalog rates; excludes discounts, caching adjustments and gateway fees.">
							{(
								message.metadata.usage.inputTokens +
								message.metadata.usage.outputTokens
							).toLocaleString()}{" "}
							tokens
							{message.metadata.usage.estimatedCostUsd != null
								? ` · ~$${message.metadata.usage.estimatedCostUsd.toFixed(4)}`
								: ""}
						</span>
					)}
					<button
						type="button"
						aria-label={copied ? "Response copied" : "Copy response"}
						title={copied ? "Copied" : "Copy response"}
						onClick={() => void copy()}
					>
						{copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
					</button>
					{copyError && <span role="alert">Could not copy</span>}
				</div>
			)}
			{message.metadata?.status === "stopped" && (
				<p className="agent-run-warning">
					Stopped. Any changes already saved remain available.
				</p>
			)}
			{message.metadata?.status === "failed" && (
				<p className="agent-run-warning">
					<WarningCircleIcon size={13} />
					Some steps could not finish. Saved drafts are still available.
				</p>
			)}
		</article>
	);
}
