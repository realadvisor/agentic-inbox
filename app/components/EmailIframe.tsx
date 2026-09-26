// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { useEffect, useRef, useState } from "react";
import { createEmailDocument } from "~/lib/email-document";

interface EmailIframeProps {
	body: string;
	/** When true, iframe auto-sizes to content height instead of filling parent */
	autoSize?: boolean;
}

/** Email CSS stays isolated in an opaque-origin sandbox. Only our nonce-bearing sizing script runs. */
export default function EmailIframe({ body, autoSize = false }: EmailIframeProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(100);

	useEffect(() => {
		const iframe = iframeRef.current;
		if (!iframe) return;
		const nonce = crypto.randomUUID();
		const onMessage = (event: MessageEvent) => {
			if (!autoSize || event.source !== iframe.contentWindow) return;
			const data = event.data;
			if (data?.__emailIframeHeight === true && data.token === nonce &&
				typeof data.height === "number" && Number.isFinite(data.height) && data.height > 0) {
				setHeight(Math.min(Math.ceil(data.height), 100_000));
			}
		};
		window.addEventListener("message", onMessage);
		setHeight(100);
		iframe.srcdoc = createEmailDocument(body, autoSize, nonce);
		return () => window.removeEventListener("message", onMessage);
	}, [body, autoSize]);

	return (
		<iframe
			ref={iframeRef}
			className="block w-full border-0"
			style={autoSize ? { height: `${height}px` } : { height: "100%" }}
			sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
			referrerPolicy="no-referrer"
			title="Email content"
		/>
	);
}
