// Only Workers AI models with tool calling; validated on both settings writes and runs.
export const AGENT_MODELS = [
	{ id: "@cf/moonshotai/kimi-k2.6", name: "Kimi K2.6" },
	{ id: "@cf/zai-org/glm-4.7-flash", name: "GLM 4.7 Flash" },
	{ id: "@cf/qwen/qwen3-30b-a3b-fp8", name: "Qwen3 30B" },
] as const;
export type AgentModel = (typeof AGENT_MODELS)[number]["id"];
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
	status: "running" | "complete" | "failed";
	actions: AgentAction[];
	created_at: string;
}
export interface AgentState {
	available: boolean;
	autoDraftAvailable: boolean;
	settings: AgentSettings;
	turns: AgentTurn[];
}
export type AgentEvent =
	| { type: "text"; text: string }
	| { type: "action"; action: AgentAction }
	| { type: "done" }
	| { type: "error"; message: string };
