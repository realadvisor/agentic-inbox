ALTER TABLE tag_groups DROP CONSTRAINT tag_groups_selection_check;
ALTER TABLE tag_groups ADD CONSTRAINT tag_groups_selection_check CHECK(selection IN ('single','multiple','score'));
CREATE OR REPLACE FUNCTION enforce_tag_group() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g uuid; mode text;
BEGIN
 SELECT t.group_id,tg.selection INTO g,mode FROM tags t JOIN tag_groups tg ON tg.id=t.group_id WHERE t.id=NEW.tag_id;
 IF g IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM conversations WHERE mailbox_id=NEW.mailbox_id AND thread_id=NEW.thread_id FOR UPDATE;
 IF NEW.source='classifier' AND NEW.removed_at IS NULL AND EXISTS (
  SELECT 1 FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id
  WHERE ct.mailbox_id=NEW.mailbox_id AND ct.thread_id=NEW.thread_id AND t.group_id=g AND ct.source='manual'
 ) THEN RETURN NULL; END IF;
 IF mode IN ('single','score') AND NEW.removed_at IS NULL THEN
  IF NEW.source='classifier' AND EXISTS (
   SELECT 1 FROM conversation_classifications j JOIN classifiers c ON c.id=j.classifier_id JOIN tags t ON t.id=c.tag_id
   JOIN conversations v ON v.mailbox_id=j.mailbox_id AND v.thread_id=j.thread_id
   WHERE j.mailbox_id=NEW.mailbox_id AND j.thread_id=NEW.thread_id AND t.group_id=g
    AND t.id<>NEW.tag_id AND j.answer=true AND j.revision=c.revision AND j.generation=v.generation
  ) THEN
   UPDATE conversation_classifications j SET status='review',error='group_conflict'
    FROM classifiers c,tags t WHERE j.classifier_id=c.id AND c.tag_id=t.id AND t.group_id=g
    AND j.mailbox_id=NEW.mailbox_id AND j.thread_id=NEW.thread_id AND j.answer=true;
   UPDATE classifier_run_items i SET status='review' FROM conversation_classifications j
    WHERE i.run_id=j.run_id AND i.mailbox_id=j.mailbox_id AND i.thread_id=j.thread_id
     AND j.mailbox_id=NEW.mailbox_id AND j.thread_id=NEW.thread_id AND j.error='group_conflict';
   UPDATE classifier_provider_run_items i SET disposition='review',error='group_conflict' FROM conversation_classifications j
    WHERE i.job_token=j.token AND j.mailbox_id=NEW.mailbox_id AND j.thread_id=NEW.thread_id AND j.error='group_conflict';
   UPDATE conversation_tags ct SET removed_at=now(),updated_at=now() FROM tags t
    WHERE ct.tag_id=t.id AND t.group_id=g AND ct.mailbox_id=NEW.mailbox_id AND ct.thread_id=NEW.thread_id AND ct.source='classifier' AND ct.removed_at IS NULL;
   NEW.removed_at:=now();
  ELSE
   UPDATE conversation_tags ct SET removed_at=now(),updated_at=now() FROM tags t
    WHERE ct.tag_id=t.id AND t.group_id=g AND t.id<>NEW.tag_id
    AND ct.mailbox_id=NEW.mailbox_id AND ct.thread_id=NEW.thread_id AND ct.removed_at IS NULL;
  END IF;
 END IF;
 RETURN NEW;
END; $$;
