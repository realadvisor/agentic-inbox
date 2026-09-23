-- 004 is reserved by the independent reply-classifier PR.
CREATE TABLE conversations (
  mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL,
  PRIMARY KEY (mailbox_id, thread_id)
);
-- Keep concurrent arrivals out of the gap between backfill and trigger installation.
LOCK TABLE emails IN SHARE ROW EXCLUSIVE MODE;
INSERT INTO conversations SELECT DISTINCT mailbox_id, thread_id FROM emails;
CREATE FUNCTION register_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO conversations VALUES (NEW.mailbox_id, NEW.thread_id)
    ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER register_email_conversation AFTER INSERT OR UPDATE OF mailbox_id, thread_id
  ON emails FOR EACH ROW EXECUTE FUNCTION register_conversation();
ALTER TABLE emails ADD FOREIGN KEY (mailbox_id, thread_id)
  REFERENCES conversations(mailbox_id, thread_id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND length(name) BETWEEN 1 AND 80),
  color text NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tags_name_unique ON tags(lower(name));
CREATE TABLE conversation_tags (
  mailbox_id text NOT NULL,
  thread_id uuid NOT NULL,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('manual', 'classifier')),
  actor text NOT NULL CHECK (length(actor) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  PRIMARY KEY (mailbox_id, thread_id, tag_id),
  FOREIGN KEY (mailbox_id, thread_id) REFERENCES conversations(mailbox_id, thread_id) ON DELETE CASCADE
);
CREATE INDEX conversation_tags_filter ON conversation_tags(mailbox_id, tag_id, thread_id)
  WHERE removed_at IS NULL;
COMMENT ON TABLE conversation_tags IS 'Latest explicit decision per conversation/tag. Manual removals are tombstones: future classifiers must preserve manual choices, including removed_at IS NOT NULL. No classifier is implemented here.';
