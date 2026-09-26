import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";

export function useRecipientSuggestions(
	mailbox: string | undefined,
	input: string,
	excluded: string[],
) {
	const search = input.trim().toLowerCase();
	const [debounced, setDebounced] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setDebounced(search), 150);
		return () => clearTimeout(timer);
	}, [search]);
	const addresses = [...new Set(excluded.map((s) => s.toLowerCase()))].sort();
	const result = useQuery({
		queryKey: ["recipient-suggestions", mailbox, debounced, addresses],
		queryFn: ({ signal }) =>
			api.recipientSuggestions(mailbox!, debounced, addresses, signal),
		enabled: !!mailbox && debounced.length >= 2 && debounced === search,
		staleTime: 60_000,
		retry: false,
	});
	const current = debounced === search && search.length >= 2;
	return {
		suggestions: current ? (result.data ?? []) : [],
		unavailable: current && result.isError,
	};
}
