import DOMPurify from "dompurify";
import * as cssTree from "css-tree";

/** Keep layout CSS, but never fetch resources through stylesheets. */
export function sanitizeEmailCss(css: string, inline = false): string {
	try {
		const ast = cssTree.parse(css, { context: inline ? "declarationList" : "stylesheet", parseCustomProperty: true });
		cssTree.walk(ast, {
			enter(node: cssTree.CssNode, item: cssTree.ListItem<cssTree.CssNode> | null, list: cssTree.List<cssTree.CssNode> | null) {
				if (node.type === "Atrule" && !["media", "supports"].includes(node.name.toLowerCase())) {
					if (item && list) list.remove(item);
					return cssTree.walk.skip;
				}
				if (node.type === "Raw" && item && list) {
					list.remove(item);
					return cssTree.walk.skip;
				}
				if (node.type !== "Declaration") return;
				let unsafe = /^(behavior|-moz-binding)$/i.test(node.property);
				cssTree.walk(node.value, (value) => {
					if (value.type === "Url" || value.type === "Raw") unsafe = true;
					// Fail closed for functions that can load resources (including escaped names).
					if (value.type === "Function" && !/^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|calc|min|max|clamp|var|env|linear-gradient|radial-gradient|repeating-linear-gradient|repeating-radial-gradient)$/i.test(value.name)) unsafe = true;
				});
				if (unsafe && item && list) list.remove(item);
			},
		});
		return cssTree.generate(ast);
	} catch {
		return "";
	}
}

/** Browser-only: build a complete, isolated email document, preserving body attributes. */
export function createEmailDocument(html: string, autoSize: boolean, nonce: string): string {
	const clean = DOMPurify.sanitize(html, {
		WHOLE_DOCUMENT: true,
		USE_PROFILES: { html: true },
		FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input", "button", "textarea", "select", "meta", "link", "base", "audio", "video"],
		FORBID_ATTR: ["nonce", "srcdoc", "autofocus", "ping"],
		ADD_ATTR: ["target"],
	});
	const doc = new DOMParser().parseFromString(clean, "text/html");
	for (const style of doc.querySelectorAll("style")) {
		style.textContent = sanitizeEmailCss(style.textContent || "");
	}
	for (const element of doc.querySelectorAll<HTMLElement>("[style]")) {
		element.setAttribute("style", sanitizeEmailCss(element.getAttribute("style") || "", true));
	}
	for (const anchor of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		anchor.target = "_blank";
		anchor.rel = "noopener noreferrer";
	}
	const csp = doc.createElement("meta");
	csp.httpEquiv = "Content-Security-Policy";
	csp.content = `default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src https: data: cid:; font-src 'none'; script-src 'nonce-${nonce}';`;
	const referrer = doc.createElement("meta");
	referrer.name = "referrer";
	referrer.content = "no-referrer";
	const viewport = doc.createElement("meta");
	viewport.name = "viewport";
	viewport.content = "width=device-width, initial-scale=1";
	const defaults = doc.createElement("style");
	// Low specificity, inserted before sender styles. No table/paragraph/image resets.
	defaults.textContent = `:where(html) { background: white; color-scheme: light; }
:where(body) { margin: 0; padding: ${autoSize ? "0" : "24px"}; font-family: Arial, sans-serif; font-size: 14px; color: #1a1a1a; }
:where(a) { color: #2563eb; }`;
	doc.head.prepend(csp, referrer, viewport, defaults);
	if (autoSize) {
		const script = doc.createElement("script");
		script.setAttribute("nonce", nonce);
		// Measure intrinsic body size, not viewport scrollHeight, so the frame can shrink.
		// Observe subsequent layout changes, including images, fonts and responsive reflow.
		script.textContent = `(() => {
let scheduled = false;
let previous = 0;
function report() {
 scheduled = false;
 const body = document.body;
 const rect = body.getBoundingClientRect();
 const style = getComputedStyle(body);
 const height = Math.ceil(Math.max(body.scrollHeight, rect.height) + Math.max(0, rect.top) + (parseFloat(style.marginBottom) || 0) + Math.max(0, window.innerHeight - document.documentElement.clientHeight));
 if (height > 0 && height !== previous) {
  previous = height;
  parent.postMessage({ __emailIframeHeight: true, token: ${JSON.stringify(nonce)}, height }, '*');
 }
}
function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(report); } }
new ResizeObserver(schedule).observe(document.body);
document.addEventListener('load', schedule, true);
document.addEventListener('error', schedule, true);
window.addEventListener('resize', schedule);
if (document.fonts) document.fonts.ready.then(schedule);
schedule();
})();`;
		doc.body.append(script);
	}
	return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
