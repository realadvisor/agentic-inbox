-- Additive: older Workers continue to ingest normally during deployment.
CREATE TABLE inbound_recovery (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 mailbox_id text NOT NULL REFERENCES mailboxes(id),
 raw_hash text NOT NULL CHECK (raw_hash ~ '^[a-f0-9]{64}$'),
 raw_storage_key text NOT NULL,
 envelope_from text NOT NULL,
 size integer NOT NULL CHECK (size BETWEEN 0 AND 10485760),
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','failed','complete')),
 failure_stage text CHECK (failure_stage IN ('parse','delivery')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 replayed_by text,
 replayed_at timestamptz,
 UNIQUE(mailbox_id,raw_hash)
);
CREATE INDEX inbound_recovery_unresolved ON inbound_recovery(created_at) WHERE status<>'complete';
CREATE INDEX inbound_recovery_completed ON inbound_recovery(updated_at) WHERE status='complete';
COMMENT ON TABLE inbound_recovery IS 'Private ingestion recovery journal. Unresolved rows and referenced raw objects must not be pruned.';
