CREATE TABLE agent_settings (
 mailbox_id text PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
 model text NOT NULL DEFAULT '@cf/moonshotai/kimi-k2.6',
 system_prompt text NOT NULL DEFAULT '',
 auto_draft boolean NOT NULL DEFAULT false,
 active_run uuid,
 lease_until timestamptz
);
CREATE TABLE agent_turns (
 id uuid PRIMARY KEY,
 mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 model text NOT NULL,
 actor text NOT NULL,
 prompt text NOT NULL,
 answer text NOT NULL DEFAULT '',
 actions jsonb NOT NULL DEFAULT '[]',
 status text NOT NULL CHECK(status IN ('running','complete','failed')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_turns_mailbox ON agent_turns(mailbox_id,created_at DESC);
CREATE TABLE agent_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 mailbox_id text NOT NULL,
 email_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','failed','skipped')),
 published_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(mailbox_id,email_id),
 FOREIGN KEY(mailbox_id,email_id) REFERENCES emails(mailbox_id,id) ON DELETE CASCADE
);
CREATE INDEX agent_jobs_pending ON agent_jobs(created_at) WHERE status='pending';
-- Future incoming mail only. This trigger also covers ingestion outside the Worker.
CREATE FUNCTION enqueue_agent_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.delivery_status='received' AND NEW.folder_id='inbox' AND
    EXISTS(SELECT 1 FROM agent_settings WHERE mailbox_id=NEW.mailbox_id AND auto_draft) THEN
   INSERT INTO agent_jobs(mailbox_id,email_id) VALUES(NEW.mailbox_id,NEW.id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_incoming_email AFTER INSERT ON emails FOR EACH ROW EXECUTE FUNCTION enqueue_agent_draft();
