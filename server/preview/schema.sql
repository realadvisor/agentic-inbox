CREATE TABLE IF NOT EXISTS preview_classifiers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tag_id uuid NOT NULL UNIQUE REFERENCES tags(id),
 question text NOT NULL,
 mailbox_ids text[] NOT NULL DEFAULT '{}',
 enabled boolean NOT NULL DEFAULT false,
 revision int NOT NULL DEFAULT 1,
 fixture_question text,
 fixture_key text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS preview_classifications (
 mailbox_id text NOT NULL,
 thread_id uuid NOT NULL,
 classifier_id uuid NOT NULL REFERENCES preview_classifiers(id),
 revision int NOT NULL,
 answer boolean,
 source text NOT NULL DEFAULT 'fixture',
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(mailbox_id,thread_id,classifier_id),
 FOREIGN KEY(mailbox_id,thread_id) REFERENCES conversations(mailbox_id,thread_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS preview_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 classifier_id uuid NOT NULL REFERENCES preview_classifiers(id),
 status text NOT NULL DEFAULT 'running',
 targets jsonb NOT NULL,
 total int NOT NULL,
 processed int NOT NULL DEFAULT 0,
 review int NOT NULL DEFAULT 0,
 skipped int NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS preview_one_run ON preview_runs(classifier_id) WHERE status='running';
CREATE TABLE IF NOT EXISTS preview_fixtures (
 mailbox_id text NOT NULL,
 thread_id uuid NOT NULL,
 answers jsonb NOT NULL,
 PRIMARY KEY(mailbox_id,thread_id),
 FOREIGN KEY(mailbox_id,thread_id) REFERENCES conversations(mailbox_id,thread_id) ON DELETE CASCADE
);
