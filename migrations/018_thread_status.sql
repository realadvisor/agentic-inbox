-- Add conversation workflow state independently of assistant conversations.
ALTER TABLE conversations
 ADD COLUMN status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','waiting','done')),
 ADD COLUMN waiting_reason text,
 ADD COLUMN follow_up_at timestamptz,
 ADD COLUMN revision integer NOT NULL DEFAULT 0,
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN updated_by text NOT NULL DEFAULT 'System',
 ADD CONSTRAINT conversation_waiting_state CHECK (
  (status = 'waiting' AND waiting_reason IS NOT NULL AND length(trim(waiting_reason)) > 0)
  OR (status <> 'waiting' AND waiting_reason IS NULL AND follow_up_at IS NULL));
CREATE INDEX conversations_status ON conversations(mailbox_id, status);
CREATE INDEX conversations_follow_up ON conversations(follow_up_at) WHERE status = 'waiting' AND follow_up_at IS NOT NULL;

CREATE TABLE thread_activity (
  id uuid PRIMARY KEY,
  mailbox_id text NOT NULL,
  thread_id uuid NOT NULL,
  from_status text NOT NULL CHECK (from_status IN ('open', 'waiting', 'done')),
  to_status text NOT NULL CHECK (to_status IN ('open', 'waiting', 'done')),
  actor text NOT NULL,
  reason text,
  follow_up_at timestamptz,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mailbox_id, thread_id) REFERENCES conversations(mailbox_id, thread_id) ON DELETE CASCADE,
  UNIQUE (mailbox_id, thread_id, revision)
);

-- AFTER INSERT excludes deduplicated messages. The thread row lock serializes
-- ingestion with status changes, so stale decisions cannot close new mail.
CREATE FUNCTION inbox_message_thread() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous conversations%ROWTYPE;
BEGIN
  -- register_email_conversation runs first (triggers execute alphabetically).
  SELECT * INTO previous FROM conversations WHERE mailbox_id = NEW.mailbox_id AND thread_id = NEW.thread_id FOR UPDATE;
  IF NEW.delivery_status <> 'draft' THEN
    UPDATE conversations SET revision = revision + 1,
      status = CASE WHEN NEW.delivery_status = 'received' THEN 'open' ELSE status END,
      waiting_reason = CASE WHEN NEW.delivery_status = 'received' THEN NULL ELSE waiting_reason END,
      follow_up_at = CASE WHEN NEW.delivery_status = 'received' THEN NULL ELSE follow_up_at END,
      updated_at = now(), updated_by = 'System'
      WHERE mailbox_id = NEW.mailbox_id AND thread_id = NEW.thread_id;
    IF NEW.delivery_status = 'received' AND previous.status <> 'open' THEN
      INSERT INTO thread_activity (id, mailbox_id, thread_id, from_status, to_status, actor, reason, revision)
      VALUES (gen_random_uuid(), NEW.mailbox_id, NEW.thread_id, previous.status, 'open', 'System', 'New incoming message', previous.revision + 1);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER status_email_insert AFTER INSERT ON emails FOR EACH ROW EXECUTE FUNCTION inbox_message_thread();
