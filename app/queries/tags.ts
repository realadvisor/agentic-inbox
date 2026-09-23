import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";

export function useTags() {
	return useQuery({ queryKey: ["tags"], queryFn: api.listTags });
}

export function useTagMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
	const client = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: async () => {
			await Promise.all(
				["tags", "emails", "search"].map((key) =>
					client.invalidateQueries({ queryKey: [key] }),
				),
			);
		},
	});
}
