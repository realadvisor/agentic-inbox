import type { Database } from "../db";

export interface HumanExample {
	answer: boolean;
	messages: unknown;
}

/** Same mailbox/question only, newest three per label; never use the target itself. */
export async function recentExamples(
	db: Database,
	classifier: string,
	mailbox: string,
	thread: string,
	question: string,
	byteBudget = 12000,
): Promise<HumanExample[]> {
	if (byteBudget <= 0) return [];
	const rows = await db<(HumanExample & { labeled_at: Date })[]>`
	 SELECT answer,messages,labeled_at FROM (
	  SELECT answer,messages,labeled_at,thread_id,
	   row_number() OVER(PARTITION BY answer ORDER BY labeled_at DESC,thread_id) AS rank
	  FROM classifier_examples
	  WHERE classifier_id=${classifier} AND mailbox_id=${mailbox} AND thread_id<>${thread}
	   AND question=${question} AND labeled_at>=now()-interval '30 days'
	 ) e WHERE rank<=3 ORDER BY rank,labeled_at DESC,thread_id`;
	const examples: HumanExample[] = [];
	for (const { answer, messages } of rows) {
		const example = { answer, messages };
		const size = new TextEncoder().encode(JSON.stringify(example)).length;
		if (size > byteBudget) continue;
		examples.push(example);
		byteBudget -= size;
	}
	return examples;
}
