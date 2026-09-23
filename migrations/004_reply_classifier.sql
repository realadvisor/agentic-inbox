CREATE TABLE reply_classifications (
 mailbox_id text NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
 thread_id uuid NOT NULL,
 generation bigint NOT NULL DEFAULT 1,
 decision text CHECK (decision IN ('reply_needed','no_reply_needed','needs_review')),
 confidence double precision CHECK (confidence BETWEEN 0 AND 1),
 model text,
 prompt_version text,
 reason text,
 manual boolean NOT NULL DEFAULT false,
 actor text,
 evaluated_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 retry_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid,
 lease_until timestamptz,
 last_error text,
 PRIMARY KEY (mailbox_id,thread_id)
);
CREATE INDEX reply_classifications_pending ON reply_classifications(retry_at) WHERE decision IS NULL;
CREATE FUNCTION invalidate_reply_classification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP <> 'INSERT' AND OLD.delivery_status IN ('received','sent')
  AND EXISTS (SELECT 1 FROM mailboxes WHERE id=OLD.mailbox_id) THEN
  INSERT INTO reply_classifications(mailbox_id,thread_id) VALUES(OLD.mailbox_id,OLD.thread_id)
  ON CONFLICT(mailbox_id,thread_id) DO UPDATE SET generation=reply_classifications.generation+1,
   decision=NULL,confidence=NULL,manual=false,actor=NULL,reason=NULL,evaluated_at=NULL,
   attempts=0,retry_at=now(),lease_id=NULL,lease_until=NULL,last_error=NULL;
 END IF;
 IF TG_OP <> 'DELETE' AND NEW.delivery_status IN ('received','sent') THEN
  INSERT INTO reply_classifications(mailbox_id,thread_id) VALUES(NEW.mailbox_id,NEW.thread_id)
  ON CONFLICT(mailbox_id,thread_id) DO UPDATE SET generation=reply_classifications.generation+1,
   decision=NULL,confidence=NULL,manual=false,actor=NULL,reason=NULL,evaluated_at=NULL,
   attempts=0,retry_at=now(),lease_id=NULL,lease_until=NULL,last_error=NULL;
 END IF;
 RETURN NULL;
END;
$$;
CREATE TRIGGER reply_classifier_changed AFTER INSERT OR DELETE OR UPDATE OF
 delivery_status,body,subject,sender,recipient,cc,thread_id ON emails
 FOR EACH ROW EXECUTE FUNCTION invalidate_reply_classification();
INSERT INTO reply_classifications(mailbox_id,thread_id)
 SELECT DISTINCT mailbox_id,thread_id FROM emails WHERE delivery_status IN ('received','sent');
