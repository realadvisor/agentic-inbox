-- No keys, members, mailboxes or tags are seeded.
CREATE TABLE inbox_api_keys (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL,
 token_hash text NOT NULL UNIQUE,
 prefix text NOT NULL,
 mailbox_ids text[] NOT NULL CHECK(cardinality(mailbox_ids)>0),
 permissions text[] NOT NULL CHECK(cardinality(permissions)>0 AND permissions <@ ARRAY['mail:read','webhooks:manage']::text[]),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz,
 last_used_at timestamptz,
 request_count bigint NOT NULL DEFAULT 0,
 revoked_at timestamptz
);
ALTER TABLE webhook_endpoints ADD COLUMN api_key_id uuid REFERENCES inbox_api_keys(id);
CREATE INDEX webhook_endpoints_api_key ON webhook_endpoints(api_key_id) WHERE api_key_id IS NOT NULL;
