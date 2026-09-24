CREATE TABLE agent_conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 title text NOT NULL DEFAULT 'New conversation',
 legacy boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(mailbox_id,id)
);
CREATE UNIQUE INDEX agent_conversations_legacy ON agent_conversations(mailbox_id) WHERE legacy;
CREATE INDEX agent_conversations_recent ON agent_conversations(mailbox_id,updated_at DESC,id DESC);
ALTER TABLE agent_turns ADD COLUMN conversation_id uuid;
INSERT INTO agent_conversations(mailbox_id,title,legacy,created_at,updated_at)
 SELECT mailbox_id,'Previous conversations',true,min(created_at),max(created_at) FROM agent_turns GROUP BY mailbox_id;
UPDATE agent_turns t SET conversation_id=c.id FROM agent_conversations c WHERE c.mailbox_id=t.mailbox_id AND c.legacy;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turn_conversation FOREIGN KEY(mailbox_id,conversation_id) REFERENCES agent_conversations(mailbox_id,id) ON DELETE CASCADE;
CREATE INDEX agent_turns_conversation ON agent_turns(mailbox_id,conversation_id,created_at DESC,id DESC);
-- Keep turns from an older Worker visible during deployment or rollback.
CREATE FUNCTION assign_legacy_agent_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.conversation_id IS NULL THEN
  INSERT INTO agent_conversations(mailbox_id,title,legacy)
   VALUES(NEW.mailbox_id,'Previous conversations',true)
   ON CONFLICT(mailbox_id) WHERE legacy DO UPDATE SET updated_at=clock_timestamp()
   RETURNING id INTO NEW.conversation_id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_turn_legacy_conversation BEFORE INSERT ON agent_turns FOR EACH ROW EXECUTE FUNCTION assign_legacy_agent_conversation();
ALTER TABLE agent_turns ALTER COLUMN conversation_id SET NOT NULL;
