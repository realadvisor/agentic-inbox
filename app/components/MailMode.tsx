import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
export function useMailMode() {
	return useQuery({
		queryKey: ["mail-mode"],
		queryFn: api.getConfig,
		staleTime: 60_000,
	});
}
export function SendLabel({ sending }: { sending?: boolean }) {
	const { data } = useMailMode();
	return (
		<>
			{sending
				? "Submitting…"
				: data?.mode === "live"
					? "Send"
					: "Simulate send"}
		</>
	);
}
export function MailModeBanner() {
	const { data } = useMailMode();
	if (!data) return null;
	return (
		<div
			className="bg-amber-100 text-amber-950 px-4 py-2 text-sm text-center"
			role="status"
		>
			{data.mode === "live"
				? "Live inbox · Messages are sent from @realadvisor.com"
				: "Synthetic inbox · Sending is simulated"}
		</div>
	);
}
