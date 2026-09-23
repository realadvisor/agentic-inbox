ALTER TABLE classifiers ADD COLUMN include_reviewed_examples boolean NOT NULL DEFAULT false;

-- Frozen evidence: later replies must never change what a human label describes.
CREATE TABLE classifier_examples (
 classifier_id uuid NOT NULL REFERENCES classifiers(id) ON DELETE CASCADE,
 mailbox_id text NOT NULL,
 thread_id uuid NOT NULL,
 question text NOT NULL,
 answer boolean NOT NULL,
 source text NOT NULL CHECK (source IN ('manual', 'review')),
 actor text NOT NULL,
 messages jsonb NOT NULL,
 labeled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (classifier_id, mailbox_id, thread_id),
 FOREIGN KEY (mailbox_id, thread_id) REFERENCES conversations(mailbox_id, thread_id) ON DELETE CASCADE,
 CHECK (octet_length(messages::text) <= 12000)
);
CREATE INDEX classifier_examples_recent ON classifier_examples(classifier_id, mailbox_id, answer, labeled_at DESC);

CREATE FUNCTION capture_classifier_example() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c classifiers%ROWTYPE; evidence jsonb; label_source text;
BEGIN
 SELECT * INTO c FROM classifiers WHERE tag_id=NEW.tag_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NEW.source='manual' THEN label_source:='manual';
 ELSIF EXISTS (
  SELECT 1 FROM conversation_classifications j JOIN conversations t USING(mailbox_id,thread_id)
  WHERE j.classifier_id=c.id AND j.mailbox_id=NEW.mailbox_id AND j.thread_id=NEW.thread_id
   AND j.source='human' AND j.status='complete' AND j.revision=c.revision AND j.generation=t.generation
   AND j.actor=NEW.actor AND j.answer=(NEW.removed_at IS NULL)
 ) THEN label_source:='review';
 ELSE RETURN NULL;
 END IF;
 -- Remove a previous example even if the replacement is now too large to use.
 DELETE FROM classifier_examples WHERE classifier_id=c.id AND mailbox_id=NEW.mailbox_id AND thread_id=NEW.thread_id;
 IF NOT EXISTS(SELECT 1 FROM emails WHERE mailbox_id=NEW.mailbox_id AND thread_id=NEW.thread_id AND delivery_status='received') THEN RETURN NULL; END IF;
 IF (SELECT count(*)>30 OR coalesce(sum(octet_length(coalesce(body,'') || subject)),0)>12000 FROM emails
     WHERE mailbox_id=NEW.mailbox_id AND thread_id=NEW.thread_id AND delivery_status IN ('received','sent')) THEN RETURN NULL; END IF;
 SELECT jsonb_agg(to_jsonb(m) ORDER BY m.date,m.id) INTO evidence FROM (
  SELECT e.id, e.sender AS "from",e.recipient AS "to",e.cc,e.subject,e.body AS body_html,e.date,
   CASE WHEN e.delivery_status='sent' THEN 'outbound' ELSE 'inbound' END AS direction,
   (SELECT count(*) FROM attachments a WHERE a.email_id=e.id AND a.mailbox_id=e.mailbox_id) AS attachment_count
  FROM emails e WHERE e.mailbox_id=NEW.mailbox_id AND e.thread_id=NEW.thread_id AND e.delivery_status IN ('received','sent')
 ) m;
 IF evidence IS NULL OR octet_length(evidence::text)>12000 THEN RETURN NULL; END IF;
 INSERT INTO classifier_examples(classifier_id,mailbox_id,thread_id,question,answer,source,actor,messages)
 VALUES(c.id,NEW.mailbox_id,NEW.thread_id,c.question,NEW.removed_at IS NULL,label_source,NEW.actor,evidence);
 RETURN NULL;
END; $$;
CREATE TRIGGER capture_classifier_example AFTER INSERT OR UPDATE ON conversation_tags
 FOR EACH ROW EXECUTE FUNCTION capture_classifier_example();
-- Existing labels have no historical conversation snapshot, so are not backfilled.
