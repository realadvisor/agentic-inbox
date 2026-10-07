// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

interface EmailPanelHeaderProps {
	subject: string;
	messageCount: number;
	showThreadCount: boolean;
}

export default function EmailPanelHeader({
	subject,
	messageCount,
	showThreadCount,
}: EmailPanelHeaderProps) {
	return (
		<div className="flex min-h-12 flex-col justify-center px-4 py-2 border-b border-kumo-line shrink-0 md:px-6">
			<h2 className="text-base font-semibold text-kumo-default">{subject}</h2>
			{showThreadCount && (
				<span className="text-xs text-kumo-subtle mt-0.5 block">
					{messageCount} messages in this thread
				</span>
			)}
		</div>
	);
}
