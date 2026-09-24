ALTER TABLE tags ADD COLUMN description text NOT NULL DEFAULT '' CHECK(length(description)<=1000);
-- Several classifier jobs can share one native Choice question in a provider call.
ALTER TABLE classifier_provider_run_items DROP CONSTRAINT classifier_provider_run_items_pkey;
ALTER TABLE classifier_provider_run_items ADD PRIMARY KEY(run_id,job_token);
