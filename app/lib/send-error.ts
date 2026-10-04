/** Preserve explicit send-journal outcomes (including recovered acceptance).
 * Transport failures and server errors cannot establish delivery either way. */
export function sendErrorMessage(error: unknown) {
	const message =
		error instanceof Error ? error.message : "Unable to submit message.";
	const uncertain =
		!(error instanceof Error) ||
		error instanceof TypeError ||
		error.name === "AbortError" ||
		error.name === "TimeoutError" ||
		("status" in error &&
			typeof error.status === "number" &&
			error.status >= 500);
	return uncertain
		? `Delivery is unconfirmed. Check Sent and verify delivery before retrying. Your draft is preserved. ${message}`
		: message;
}
