ALTER TABLE sender_identities ADD COLUMN name text;
ALTER TABLE sender_identities ADD COLUMN archived_at timestamptz;
ALTER TABLE sender_identities DROP CONSTRAINT sender_identities_email_key;
CREATE UNIQUE INDEX sender_identities_available_email ON sender_identities(lower(email)) WHERE archived_at IS NULL;
