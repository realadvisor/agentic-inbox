CREATE TABLE agent_models (
 id text PRIMARY KEY,
 name text NOT NULL,
 provider text NOT NULL,
 source text NOT NULL CHECK(source IN ('workers','gateway')),
 available boolean NOT NULL DEFAULT true,
 context_window integer,
 input_price double precision,
 output_price double precision,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO agent_models(id,name,provider,source) VALUES
 ('@cf/moonshotai/kimi-k2.6','Kimi K2.6','Moonshot AI','workers'),
 ('@cf/zai-org/glm-4.7-flash','GLM 4.7 Flash','Z.ai','workers'),
 ('@cf/qwen/qwen3-30b-a3b-fp8','Qwen3 30B','Qwen','workers');
CREATE TABLE agent_catalog_sync (
 id integer PRIMARY KEY CHECK(id=1),
 refreshed_at timestamptz NOT NULL DEFAULT now()
);
