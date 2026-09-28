-- Existing endpoints retain their unfiltered event behavior. No tags are created.
ALTER TABLE webhook_endpoints ADD COLUMN include_tag_ids uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN exclude_tag_ids uuid[] NOT NULL DEFAULT '{}',
 ADD COLUMN tag_match text NOT NULL DEFAULT 'any' CHECK(tag_match IN ('any','all'));
CREATE INDEX webhook_endpoints_active_mailbox ON webhook_endpoints(mailbox_id) WHERE enabled;
CREATE TABLE webhook_matches (
 endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
 thread_id uuid NOT NULL,
 matched boolean NOT NULL,
 PRIMARY KEY(endpoint_id,thread_id)
);
CREATE FUNCTION webhook_tags_match(actual uuid[], included uuid[], excluded uuid[], mode text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT NOT(actual && excluded) AND (cardinality(included)=0 OR CASE WHEN mode='all' THEN actual @> included ELSE actual && included END);
$$;
CREATE FUNCTION webhook_thread_tags(mailbox text, thread uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
 SELECT coalesce(array_agg(t.id ORDER BY t.id),'{}'::uuid[]) FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id
 WHERE ct.mailbox_id=mailbox AND ct.thread_id=thread AND ct.removed_at IS NULL AND t.archived_at IS NULL;
$$;
CREATE OR REPLACE FUNCTION emit_inbox_webhook(mailbox text, event_type text, data jsonb, dedupe text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE event_id uuid := gen_random_uuid(); thread uuid; current_tags uuid[];
BEGIN
 IF current_setting('inbox.historical_import',true)='on' THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM webhook_endpoints WHERE mailbox_id=mailbox AND enabled AND event_type=ANY(events)) THEN RETURN NULL; END IF;
 thread := (data->>'conversation_id')::uuid;
 current_tags := webhook_thread_tags(mailbox,thread);
 INSERT INTO webhook_events(id,mailbox_id,type,payload,dedupe_key) VALUES(event_id,mailbox,event_type,
 jsonb_build_object('id',event_id,'type',event_type,'timestamp',clock_timestamp(),'mailbox_id',mailbox,'data',data||jsonb_build_object('tag_ids',current_tags)),dedupe)
 ON CONFLICT(dedupe_key) DO NOTHING;
 IF NOT FOUND THEN RETURN NULL; END IF;
 INSERT INTO webhook_deliveries(event_id,endpoint_id)
 SELECT event_id,id FROM webhook_endpoints WHERE mailbox_id=mailbox AND enabled AND event_type=ANY(events)
 AND webhook_tags_match(current_tags,include_tag_ids,exclude_tag_ids,tag_match);
 RETURN event_id;
END $$;
-- Deferred evaluation sees the final tag set, not intermediate mutations when
-- classifiers replace levels or apply several tags in one transaction.
CREATE FUNCTION evaluate_webhook_matches(mailbox text, thread uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE endpoint record; actual uuid[]; matches boolean; previous boolean; event_id uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM webhook_endpoints WHERE mailbox_id=mailbox AND enabled AND 'conversation.matched'=ANY(events)) THEN RETURN; END IF;
 PERFORM 1 FROM conversations WHERE mailbox_id=mailbox AND thread_id=thread FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 actual := webhook_thread_tags(mailbox,thread);
 FOR endpoint IN SELECT * FROM webhook_endpoints WHERE mailbox_id=mailbox AND enabled AND 'conversation.matched'=ANY(events) ORDER BY id FOR SHARE LOOP
  matches := webhook_tags_match(actual,endpoint.include_tag_ids,endpoint.exclude_tag_ids,endpoint.tag_match);
  -- The row lock serializes concurrent changes to the same endpoint/conversation.
  INSERT INTO webhook_matches(endpoint_id,thread_id,matched) VALUES(endpoint.id,thread,false) ON CONFLICT DO NOTHING;
  SELECT matched INTO previous FROM webhook_matches WHERE endpoint_id=endpoint.id AND thread_id=thread FOR UPDATE;
  UPDATE webhook_matches SET matched=matches WHERE endpoint_id=endpoint.id AND thread_id=thread;
  IF matches AND NOT previous AND current_setting('inbox.historical_import',true) IS DISTINCT FROM 'on' THEN
   event_id := gen_random_uuid();
   INSERT INTO webhook_events(id,mailbox_id,type,payload) VALUES(event_id,mailbox,'conversation.matched',
    jsonb_build_object('id',event_id,'type','conversation.matched','timestamp',clock_timestamp(),'mailbox_id',mailbox,'data',jsonb_build_object('conversation_id',thread,'tag_ids',actual)));
   INSERT INTO webhook_deliveries(event_id,endpoint_id) VALUES(event_id,endpoint.id);
  END IF;
 END LOOP;
END $$;
CREATE FUNCTION webhook_match_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='emails' THEN
  IF NEW.delivery_status NOT IN ('received','sent') THEN RETURN NULL; END IF;
 END IF;
 IF TG_OP='DELETE' THEN
  PERFORM evaluate_webhook_matches(OLD.mailbox_id,OLD.thread_id);
 ELSE
  PERFORM evaluate_webhook_matches(NEW.mailbox_id,NEW.thread_id);
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER webhook_match_tags AFTER INSERT OR UPDATE OR DELETE ON conversation_tags DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION webhook_match_change();
CREATE CONSTRAINT TRIGGER webhook_match_email AFTER INSERT ON emails DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION webhook_match_change();
-- Removing a tag from the catalogue must also update matching state.
CREATE FUNCTION webhook_match_archive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE row record;
BEGIN
 IF OLD.archived_at IS DISTINCT FROM NEW.archived_at THEN
  FOR row IN SELECT DISTINCT mailbox_id,thread_id FROM conversation_tags WHERE tag_id=NEW.id LOOP
   PERFORM evaluate_webhook_matches(row.mailbox_id,row.thread_id);
  END LOOP;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER webhook_match_archive AFTER UPDATE ON tags DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION webhook_match_archive();
