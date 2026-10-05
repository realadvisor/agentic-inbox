import { parse, type DefaultTreeAdapterMap } from "parse5";
import { z } from "zod";

type Node = DefaultTreeAdapterMap["node"];
const skipped = new Set([
	"script",
	"style",
	"head",
	"template",
	"noscript",
	"svg",
	"math",
]);

/** Keep original HTML bytes; only replace source spans belonging to text nodes. */
export function translationDocument(html: string) {
	const segments: { id: number; text: string; start: number; end: number }[] =
		[];
	function visit(node: Node) {
		if (
			"tagName" in node &&
			(skipped.has(node.tagName) ||
				node.attrs.some(
					(a) =>
						a.name === "hidden" ||
						(a.name === "translate" && a.value === "no") ||
						(a.name === "aria-hidden" && a.value === "true") ||
						(a.name === "style" &&
							/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(a.value)),
				))
		)
			return;
		if (
			node.nodeName === "#text" &&
			"value" in node &&
			node.value.trim() &&
			node.sourceCodeLocation
		) {
			segments.push({
				id: segments.length,
				text: node.value,
				start: node.sourceCodeLocation.startOffset,
				end: node.sourceCodeLocation.endOffset,
			});
		}
		if ("childNodes" in node) node.childNodes.forEach(visit);
	}
	visit(parse(html, { sourceCodeLocationInfo: true }));
	return {
		segments: segments.map(({ id, text }) => ({ id, text })),
		apply(raw: string) {
			const values = z
				.object({
					segments: z.array(
						z
							.object({ id: z.number().int(), text: z.string().max(64000) })
							.strict(),
					),
				})
				.strict()
				.parse(JSON.parse(raw)).segments;
			const byId = new Map(values.map((s) => [s.id, s.text]));
			if (
				values.length !== segments.length ||
				byId.size !== segments.length ||
				segments.some((s) => !byId.get(s.id)?.trim())
			)
				throw new Error("Incomplete translation");
			let result = html;
			for (const segment of [...segments].sort((a, b) => b.start - a.start)) {
				const text = byId.get(segment.id)!;
				// Preserve spacing around inline emphasis and links; model output is text, never markup.
				const padded =
					(segment.text.match(/^\s*/)?.[0] ?? "") +
					text.trim() +
					(segment.text.match(/\s*$/)?.[0] ?? "");
				const escaped = padded
					.replaceAll("&", "&amp;")
					.replaceAll("<", "&lt;")
					.replaceAll(">", "&gt;");
				result =
					result.slice(0, segment.start) + escaped + result.slice(segment.end);
			}
			return {
				html: result,
				text: segments.map((s) => byId.get(s.id)!.trim()).join("\n"),
			};
		},
	};
}
