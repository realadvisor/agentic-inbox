import {
	groupChoice,
	jevQuestion,
	jevRequest,
	interpretAnswer,
} from "../shared/jev-request";
import { tagGroupInput } from "../shared/tag-groups";
import {
	urgencyInstructions,
	importanceInstructions,
	urgencyDescriptions,
	importanceDescriptions,
} from "../shared/triage-defaults";
const groups = [
	{
		name: "Urgency",
		instructions: urgencyInstructions,
		descriptions: urgencyDescriptions,
	},
	{
		name: "Importance",
		instructions: importanceInstructions,
		descriptions: importanceDescriptions,
	},
].map((g) =>
	tagGroupInput.parse({
		name: g.name,
		instructions: g.instructions,
		selection: "single",
		enabled: true,
		tags: Object.entries(g.descriptions).map(([name, description], i) => ({
			id: `00000000-0000-4000-8000-00000000000${i}`,
			name,
			description,
			color: "#2563eb",
		})),
	}),
);
const cases = [
	{
		id: "newsletter",
		text: "For your information: our monthly newsletter. No action required.",
		expected: ["Low", "Low"],
	},
	{
		id: "appointment_today",
		text: "Our scheduled property viewing is in one hour. Please send the entrance code before then or the customer cannot attend.",
		expected: ["High", "Medium"],
	},
	{
		id: "privacy_incident",
		text: "Customer identity documents are publicly accessible on our website right now. Please restrict access immediately to stop the exposure.",
		expected: ["High", "High"],
	},
	{
		id: "routine_invoice",
		text: "Could you send a copy of our paid invoice for bookkeeping? It can wait until next week.",
		expected: ["Low", "Low"],
	},
	{
		id: "french_incident",
		text: "Des documents d’identité de nos clients sont accessibles publiquement sur le site. Veuillez bloquer cet accès immédiatement.",
		expected: ["High", "High"],
	},
	{
		id: "german_routine",
		text: "Nur zur Information: Hier ist der monatliche Newsletter. Es ist keine Aktion erforderlich.",
		expected: ["Low", "Low"],
	},
	{
		id: "resolved",
		text: "The customer reported a critical outage. Our team confirmed service was restored, and the customer replied: Everything works now, thank you. No further action is needed.",
		expected: ["Low", "Low"],
	},
	{
		id: "emphatic",
		text: "URGENT!!! Please send me your public brochure whenever convenient. There is no deadline, I am just browsing.",
		expected: ["Low", "Low"],
	},
];
if (!process.argv.includes("--live"))
	throw new Error(
		"Pass --live to evaluate synthetic fixtures with Jev. No mailbox content is used.",
	);
const key = process.env.TYPESAFE_API_KEY;
if (!key) throw new Error("Configure TYPESAFE_API_KEY locally.");
const results: {
	case: string;
	group: string;
	expected: string;
	choice: string | undefined;
	baseline: string;
	model: string;
}[] = [];
for (const fixture of cases) {
	const questions: Parameters<typeof jevRequest>[1] = {};
	for (const [i, g] of groups.entries()) {
		questions[`choice${i}`] = groupChoice(g);
		for (const [j, t] of g.tags.entries())
			questions[`baseline${i}_${j}`] = jevQuestion(
				`Classify the conversation in the ${JSON.stringify(g.name)} group.\n${g.instructions}\nTag definitions: ${JSON.stringify(Object.fromEntries(g.tags.map((t) => [t.name, t.description])))}\nAvailable tags: ${JSON.stringify(g.tags.map((t) => t.name))}.\nChoose exactly one best-fitting tag; if the evidence is insufficient, return uncertainty.\nShould ${JSON.stringify(t.name)} be selected in this group?`,
			);
	}
	const response = await fetch("https://api.typesafe.ai/v1/systemone", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(
			jevRequest(
				{
					our_mailbox: "support@example.test",
					evaluated_at: new Date().toISOString(),
					timezone: "UTC",
					messages: [
						{
							from: "customer@example.test",
							direction: "inbound",
							text: fixture.text,
						},
					],
				},
				questions,
			),
		),
		signal: AbortSignal.timeout(20000),
	});
	if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
	const data = (await response.json()) as {
		model: string;
		answers: Record<string, unknown>;
	};
	for (const [i, g] of groups.entries()) {
		const choice = interpretAnswer(
			questions[`choice${i}`],
			data.answers[`choice${i}`],
		);
		const selected = g.tags.find(
			(t) => t.id === ("choice" in choice ? choice.choice : null),
		)?.name;
		const old = g.tags.map((tag, j) => ({
			tag: tag.name,
			...interpretAnswer(
				questions[`baseline${i}_${j}`],
				data.answers[`baseline${i}_${j}`],
			),
		}));
		const positive = old.filter((r) => r.answer === true);
		const baseline =
			positive.length === 1 && !old.some((r) => r.answer === null)
				? positive[0].tag
				: "review";
		results.push({
			case: fixture.id,
			group: g.name,
			expected: fixture.expected[i],
			choice: choice.answer === null ? "review" : selected,
			baseline,
			model: data.model,
		});
	}
}
console.log(
	JSON.stringify(
		{
			note: "Small synthetic smoke evaluation, not a real-mail accuracy benchmark. Baseline holds the revised instructions constant to compare request types.",
			summary: Object.fromEntries(
				(["choice", "baseline"] as const).map((mode) => [
					mode,
					{
						correct: results.filter((r) => r[mode] === r.expected).length,
						review: results.filter((r) => r[mode] === "review").length,
						incorrect: results.filter(
							(r) => r[mode] !== "review" && r[mode] !== r.expected,
						).length,
						total: results.length,
					},
				]),
			),
			results,
		},
		null,
		2,
	),
);
