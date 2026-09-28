CREATE TABLE webhook_endpoints (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 url text NOT NULL, events text[] NOT NULL, secret text NOT NULL,
 enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 type text NOT NULL, payload jsonb NOT NULL, dedupe_key text UNIQUE, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id uuid NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
 endpoint_id uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','success','failed','skipped')),
 attempts integer NOT NULL DEFAULT 0, published_at timestamptz, available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_id uuid, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_id,endpoint_id)
);
CREATE INDEX webhook_pending ON webhook_deliveries(available_at) WHERE status='pending';
CREATE TABLE webhook_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), delivery_id uuid NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
 attempt integer NOT NULL, status_code integer, error text, response text, duration_ms integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION emit_inbox_webhook(mailbox text, event_type text, data jsonb, dedupe text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE event_id uuid := gen_random_uuid();
BEGIN
 IF NOT EXISTS(SELECT 1 FROM webhook_endpoints WHERE mailbox_id=mailbox AND enabled AND event_type=ANY(events)) THEN RETURN NULL; END IF;
 INSERT INTO webhook_events(id,mailbox_id,type,payload,dedupe_key) VALUES(event_id,mailbox,event_type,
 jsonb_build_object('id',event_id,'type',event_type,'timestamp',clock_timestamp(),'mailbox_id',mailbox,'data',data),dedupe)
 ON CONFLICT(dedupe_key) DO NOTHING;
 IF NOT FOUND THEN RETURN NULL; END IF;
 INSERT INTO webhook_deliveries(event_id,endpoint_id) SELECT event_id,id FROM webhook_endpoints WHERE mailbox_id=mailbox AND enabled AND event_type=ANY(events);
 RETURN event_id;
END $$;
CREATE FUNCTION email_webhook() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.delivery_status NOT IN ('received','sent') THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND OLD.delivery_status=NEW.delivery_status THEN RETURN NEW; END IF;
 PERFORM emit_inbox_webhook(NEW.mailbox_id,'email.'||CASE WHEN NEW.delivery_status='received' THEN 'received' ELSE 'sent' END,
 jsonb_build_object('email_id',NEW.id,'conversation_id',NEW.thread_id,'subject',NEW.subject,'from',NEW.sender,'to',NEW.recipient,'date',NEW.date),NEW.id::text||'/'||NEW.delivery_status);
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_email AFTER INSERT OR UPDATE OF delivery_status ON emails FOR EACH ROW EXECUTE FUNCTION email_webhook();
CREATE FUNCTION tags_webhook() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.removed_at IS NULL THEN
   PERFORM emit_inbox_webhook(OLD.mailbox_id,'conversation.tags_changed',jsonb_build_object('conversation_id',OLD.thread_id,'tag_id',OLD.tag_id,'source',OLD.source,'action','removed'));
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' AND NEW.removed_at IS NOT NULL THEN RETURN NEW; END IF;
 IF TG_OP='UPDATE' AND (OLD.removed_at IS NULL)=(NEW.removed_at IS NULL) AND OLD.source=NEW.source THEN RETURN NEW; END IF;
 PERFORM emit_inbox_webhook(NEW.mailbox_id,'conversation.tags_changed',jsonb_build_object('conversation_id',NEW.thread_id,'tag_id',NEW.tag_id,'source',NEW.source,'action',CASE WHEN NEW.removed_at IS NULL THEN 'added' ELSE 'removed' END));
 RETURN NEW;
END $$;
CREATE TRIGGER webhook_tags AFTER INSERT OR UPDATE OR DELETE ON conversation_tags FOR EACH ROW EXECUTE FUNCTION tags_webhook();
CREATE FUNCTION status_webhook() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.status IS DISTINCT FROM NEW.status THEN
 PERFORM emit_inbox_webhook(NEW.mailbox_id,'conversation.status_changed',jsonb_build_object('conversation_id',NEW.thread_id,'previous_status',OLD.status,'status',NEW.status,'actor',NEW.updated_by));
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER webhook_status AFTER UPDATE OF status ON conversations FOR EACH ROW EXECUTE FUNCTION status_webhook();
CREATE FUNCTION classification_webhook() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE results jsonb; fingerprint text;
BEGIN
 IF NEW.status='pending' OR OLD.status<>'pending' THEN RETURN NEW; END IF;
 IF NOT EXISTS(SELECT 1 FROM webhook_endpoints WHERE mailbox_id=NEW.mailbox_id AND enabled AND 'conversation.classified'=ANY(events)) THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM conversation_classifications WHERE mailbox_id=NEW.mailbox_id AND thread_id=NEW.thread_id AND generation=NEW.generation AND status='pending') THEN RETURN NEW; END IF;
 SELECT jsonb_agg(jsonb_build_object('classifier_id',j.classifier_id,'tag_id',c.tag_id,'status',j.status,'answer',j.answer,'probability',j.probability,'confidence',j.confidence,'score',j.score,'error',j.error) ORDER BY j.classifier_id),md5(string_agg(j.token::text||j.status,',' ORDER BY j.classifier_id)) INTO results,fingerprint
 FROM conversation_classifications j JOIN classifiers c ON c.id=j.classifier_id WHERE j.mailbox_id=NEW.mailbox_id AND j.thread_id=NEW.thread_id AND j.generation=NEW.generation;
 PERFORM emit_inbox_webhook(NEW.mailbox_id,'conversation.classified',jsonb_build_object('conversation_id',NEW.thread_id,'generation',NEW.generation,'results',results),'classified/'||NEW.mailbox_id||'/'||NEW.thread_id||'/'||fingerprint);
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER webhook_classified AFTER UPDATE ON conversation_classifications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION classification_webhook();
