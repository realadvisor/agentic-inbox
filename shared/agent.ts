import type { UIMessage } from "ai";

export interface AgentUsage {
	inputTokens: number;
	outputTokens: number;
	estimatedCostUsd?: number;
}

export type InboxChatMessage = UIMessage<{
	model?: string;
	usage?: AgentUsage;
	status?: "running" | "complete" | "failed" | "stopped";
}>;

// Workers AI seed choices. Gateway choices come from the refreshed catalog.
export const AGENT_MODELS = [
	{ id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6" },
	{ id: "@cf/zai-org/glm-4.7-flash", name: "GLM 4.7 Flash" },
	{ id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen3 30B" },
] as const;
export type AgentModel = string;
export type ModelSource = "workers" | "gateway";
export interface AgentCatalogModel {
	id: string;
	name: string;
	provider: string;
	source: ModelSource;
	available: boolean;
	selectable: boolean;
	context_window: number | null;
	input_price: number | null;
	output_price: number | null;
}
export interface AgentCatalog {
	models: AgentCatalogModel[];
	refreshed_at: string | null;
	gatewayConfigured: boolean;
}
export const DEFAULT_AGENT_MODEL: AgentModel = AGENT_MODELS[0].id;
export interface AgentSettings {
	model: AgentModel;
	system_prompt: string;
	auto_draft: boolean;
}
export interface AgentAction {
	tool: string;
	result: string;
	key?: string;
}
export interface AgentTurn {
	id: string;
	model: string;
	prompt: string;
	answer: string;
	status: "running" | "complete" | "failed" | "stopped";
	actions: AgentAction[];
	created_at: string;
	ui_message?: InboxChatMessage | null;
	usage?: AgentUsage | null;
}
export interface AgentState {
	available: boolean;
	autoDraftAvailable: boolean;
	settings: AgentSettings;
	catalog: AgentCatalog;
	turns: AgentTurn[];
}
export type AgentEvent =
	| { type: "text"; text: string }
	| { type: "action"; action: AgentAction }
	| { type: "done" }
	| { type: "error"; message: string };
