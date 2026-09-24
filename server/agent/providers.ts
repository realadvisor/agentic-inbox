import { createGateway } from "ai";
import { workersModels, type AiBinding, type ModelFactory } from "./service";
import type { ModelSource } from "../../shared/agent";

export function agentProviders(binding?: AiBinding, gatewayKey?: string) {
	const workers = binding ? workersModels(binding) : undefined;
	const gateway = gatewayKey?.trim()
		? createGateway({ apiKey: gatewayKey.trim() })
		: undefined;
	const sources: ModelSource[] = [];
	if (workers) sources.push("workers");
	if (gateway) sources.push("gateway");
	const model: ModelFactory | undefined = sources.length
		? (id) => {
				if (id.startsWith("@cf/")) {
					if (!workers) throw new Error("Workers AI is not configured");
					return workers(id);
				}
				if (!gateway) throw new Error("AI Gateway is not configured");
				return gateway(id);
			}
		: undefined;
	return { model, sources };
}
