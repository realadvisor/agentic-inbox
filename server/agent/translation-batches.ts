type Segment = { id: number; text: string };

/** Bound parallel calls to three; keep short messages in one request. */
export function translationBatches(source: Segment[]) {
	// The HTML renderer restores boundary whitespace from the original document.
	const segments = source.map(({ id, text }) => ({ id, text: text.trim() }));
	const cost = (segment: Segment) => segment.text.length + 48;
	const total = segments.reduce((sum, segment) => sum + cost(segment), 0);
	const count = Math.min(3, Math.ceil(total / 4000));
	const target = Math.ceil(total / Math.max(1, count));
	const batches: {
		segments: Segment[];
		contextBefore: string[];
		contextAfter: string[];
	}[] = [];
	let start = 0;
	while (start < segments.length) {
		let end = start,
			size = 0;
		do {
			size += cost(segments[end++]);
		} while (
			end < segments.length &&
			(batches.length === count - 1 || size < target)
		);
		batches.push({
			segments: segments.slice(start, end),
			contextBefore: segments
				.slice(Math.max(0, start - 2), start)
				.map((s) => s.text.slice(-400)),
			contextAfter: segments
				.slice(end, end + 2)
				.map((s) => s.text.slice(0, 400)),
		});
		start = end;
	}
	return batches;
}
