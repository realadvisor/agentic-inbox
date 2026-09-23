ALTER TABLE mailboxes ADD COLUMN created_by text;
ALTER TABLE mailboxes ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
