export function agentErrorMessage(error: unknown): string {
	const status =
		error && typeof error === "object" && "statusCode" in error
			? error.statusCode
			: undefined;
	if (status === 401 || status === 403)
		return "This model could not be authorized. Check the provider credentials and model access in Settings.";
	if (status === 402)
		return "The model provider has insufficient credits. Add credits or choose another provider.";
	if (status === 429)
		return "The model provider is rate limited. Wait briefly before trying again.";
	if (status === 400)
		return "The model rejected this request. Try another model; saved drafts remain available.";
	return "The assistant could not finish. Saved changes remain available. Review them before trying again.";
}
