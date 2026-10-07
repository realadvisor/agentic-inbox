// Persist the boundary inside the draft HTML so every send surface uses the same body.
export const forwardDocumentMarker = "<!--inbox-forward-document:v1-->";
export const forwardNoteStart = "<!--inbox-forward-note:start-->";
export const forwardNoteEnd = "<!--inbox-forward-note:end-->";

export function splitForwardDocument(html: string) {
	if (!html.startsWith(forwardDocumentMarker)) return undefined;
	const start = html.indexOf(forwardNoteStart);
	const end = html.indexOf(forwardNoteEnd, start + forwardNoteStart.length);
	if (start < 0 || end < 0) return undefined;
	return {
		note: html.slice(start + forwardNoteStart.length, end),
		before: html.slice(0, start + forwardNoteStart.length),
		after: html.slice(end),
	};
}
