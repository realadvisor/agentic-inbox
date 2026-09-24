CREATE TABLE classifier_provider_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 mailbox_id text NOT NULL,
 thread_id uuid NOT NULL,
 subject text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 finished_at timestamptz,
 duration_ms integer,
 status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','interrupted')),
 http_status integer,
 requested_model text NOT NULL,
 returned_model text,
 request_body text NOT NULL,
 response_body text,
 error text,
 FOREIGN KEY(mailbox_id,thread_id) REFERENCES conversations(mailbox_id,thread_id) ON DELETE CASCADE
);
CREATE INDEX classifier_provider_runs_page ON classifier_provider_runs(started_at DESC,id DESC);
CREATE INDEX classifier_provider_runs_thread ON classifier_provider_runs(mailbox_id,thread_id,started_at DESC);
CREATE TABLE classifier_provider_run_items (
 run_id uuid NOT NULL REFERENCES classifier_provider_runs(id) ON DELETE CASCADE,
 question_key text NOT NULL,
 classifier_id uuid NOT NULL,
 classifier_name text NOT NULL,
 question text NOT NULL,
 revision integer NOT NULL,
 generation integer NOT NULL,
 job_token uuid NOT NULL,
 lease_id uuid NOT NULL,
 attempt integer NOT NULL,
 probability double precision,
 answer boolean,
 disposition text NOT NULL DEFAULT 'pending' CHECK(disposition IN ('pending','applied','review','retry','discarded','failed')),
 error text,
 PRIMARY KEY(run_id,question_key)
);
CREATE INDEX classifier_provider_items_lease ON classifier_provider_run_items(lease_id);
CREATE INDEX classifier_provider_items_classifier ON classifier_provider_run_items(classifier_id,run_id);
