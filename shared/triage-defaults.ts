export const urgencyInstructions =
	"Assess how soon our team must act on the latest unresolved request. Use earlier messages as context and account for confirmed responses and resolutions. Evaluate the consequence of delay independently of overall business impact. Emphatic wording alone does not establish urgency. Do not invent deadlines.";
export const importanceInstructions =
	"Assess the customer or business impact of the latest unresolved issue independently of its deadline. Use only impact evidenced in the conversation. Do not infer customer value or high impact solely from the sender's tone. Account for confirmed resolutions.";
export const urgencyDescriptions = {
	Low: "No time-sensitive action remains; informational, resolved, or explicitly flexible request.",
	Medium:
		"Action is needed soon, but waiting until the next working day has no stated meaningful consequence.",
	High: "The conversation establishes that waiting until the next working day risks a missed commitment or material harm.",
};
export const importanceDescriptions = {
	Low: "Routine or informational matter with limited evidenced customer or business impact.",
	Medium:
		"An unresolved issue affecting a customer relationship or ordinary business process, without evidence of major harm.",
	High: "Significant evidenced customer, business, or privacy consequences, such as a critical service failure, major loss, or exposed personal data.",
};
