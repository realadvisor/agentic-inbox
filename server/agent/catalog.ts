import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import type { Database } from "../db";
import type {
	AgentCatalog,
	AgentCatalogModel,
	ModelSource,
} from "../../shared/agent";

export const modelIdSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^(?:@cf\/)?[a-zA-Z0-9._-]+\/[a-zA-Z0-9._:-]+$/);
const entrySchema = z.object({
	id: modelIdSchema,
	name: z.string().max(300).optional(),
	type: z.string(),
	tags: z.array(z.string()).optional(),
	supported_parameters: z.array(z.string()).optional(),
	supported_specifications: z.array(z.string()).optional(),
	context_window: z.number().int().positive().max(2147483647).nullish(),
	pricing: z
		.object({ input: z.string().nullish(), output: z.string().nullish() })
		.nullish(),
});
export type CatalogFetch = () => Promise<unknown>;
export const fetchGatewayCatalog: CatalogFetch = async () => {
	const response = await fetch("https://ai-gateway.vercel.sh/v1/models", {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok)
		throw new Error(`Gateway catalog returned ${response.status}`);
	return response.json();
};
const perMillion = (value: string | null | undefined) => {
	if (value == null || !value.trim()) return null;
	const number = Number(value) * 1000000;
	return Number.isFinite(number) && number >= 0 ? number : null;
};
export function parseGatewayCatalog(body: unknown) {
	const { data } = z
		.object({ data: z.array(z.unknown()).max(5000) })
		.parse(body);
	const entries = new Map<string, Omit<AgentCatalogModel, "selectable">>();
	for (const raw of data) {
		const parsed = entrySchema.safeParse(raw);
		if (!parsed.success) continue;
		const m = parsed.data;
		if (
			m.id.startsWith("@cf/") ||
			m.type !== "language" ||
			!(
				m.tags?.includes("tool-use") ||
				m.supported_parameters?.includes("tools")
			) ||
			(m.supported_specifications && !m.supported_specifications.includes("v3"))
		)
			continue;
		entries.set(m.id, {
			id: m.id,
			name: m.name || m.id,
			provider: m.id.split("/")[0],
			source: "gateway",
			available: true,
			context_window: m.context_window ?? null,
			input_price: perMillion(m.pricing?.input),
			output_price: perMillion(m.pricing?.output),
		});
	}
	if (!entries.size)
		throw new Error("Gateway returned no compatible tool-calling models");
	return [...entries.values()];
}
export async function refreshCatalog(
	db: Database,
	load: CatalogFetch = fetchGatewayCatalog,
) {
	return db.begin(async (tx) => {
		const [lock] =
			await tx`SELECT pg_try_advisory_xact_lock(7342202) AS acquired`;
		if (!lock.acquired)
			throw new HTTPException(409, {
				message: "The model catalog is already refreshing",
			});
		let entries: ReturnType<typeof parseGatewayCatalog>;
		try {
			entries = parseGatewayCatalog(await load());
		} catch {
			throw new HTTPException(502, {
				message:
					"Could not refresh the gateway catalog. Your existing model list and default were kept.",
			});
		}
		await tx`UPDATE agent_models SET available=false WHERE source='gateway'`;
		await tx`INSERT INTO agent_models(id,name,provider,source,available,context_window,input_price,output_price)
		 SELECT id,name,provider,source,available,context_window,input_price,output_price
		 FROM jsonb_to_recordset(${tx.json(entries.map((m) => ({ ...m })))}) AS m(id text,name text,provider text,source text,available boolean,context_window integer,input_price double precision,output_price double precision)
		 ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,available=true,context_window=excluded.context_window,input_price=excluded.input_price,output_price=excluded.output_price,updated_at=now()`;
		await tx`INSERT INTO agent_catalog_sync(id) VALUES(1) ON CONFLICT(id) DO UPDATE SET refreshed_at=now()`;
		return entries.length;
	});
}
export async function getCatalog(
	db: Database,
	sources: ModelSource[],
): Promise<AgentCatalog> {
	const rows = await db<
		Omit<AgentCatalogModel, "selectable">[]
	>`SELECT id,name,provider,source,available,context_window,input_price,output_price FROM agent_models ORDER BY lower(provider),lower(name),id`;
	const [sync] =
		await db`SELECT refreshed_at FROM agent_catalog_sync WHERE id=1`;
	return {
		models: rows.map((row) => ({
			...row,
			selectable: row.available && sources.includes(row.source),
		})),
		refreshed_at: sync?.refreshed_at?.toISOString() ?? null,
		gatewayConfigured: sources.includes("gateway"),
	};
}
export async function requireModel(
	db: Database,
	id: string,
	sources?: ModelSource[],
) {
	const [model] =
		await db`SELECT source FROM agent_models WHERE id=${modelIdSchema.parse(id)} AND available`;
	if (!model)
		throw new HTTPException(400, {
			message:
				"This model is not available. Refresh the model list in Settings and choose another model.",
		});
	if (sources && !sources.includes(model.source))
		throw new HTTPException(503, {
			message:
				model.source === "gateway"
					? "AI Gateway is not configured for this environment"
					: "Workers AI is not configured for this environment",
		});
}
