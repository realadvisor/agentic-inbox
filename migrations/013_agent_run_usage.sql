ALTER TABLE agent_turns DROP CONSTRAINT agent_turns_status_check;
ALTER TABLE agent_turns ADD CONSTRAINT agent_turns_status_check CHECK(status IN ('running','complete','failed','stopped'));
ALTER TABLE agent_turns ADD COLUMN usage jsonb;
