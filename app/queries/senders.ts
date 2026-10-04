import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "~/services/api";

export function useSenders() {
	return useQuery({
		queryKey: ["sender-identities"],
		queryFn: api.listSenders,
	});
}
export function useSetDefaultSender() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.setDefaultSender,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["sender-identities"] }),
	});
}

export function useSaveSender() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.saveSender,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["sender-identities"] }),
	});
}
export function useRemoveSender() {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: api.removeSender,
		onSuccess: () => qc.invalidateQueries({ queryKey: ["sender-identities"] }),
	});
}
