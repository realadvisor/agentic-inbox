CREATE TABLE tag_groups (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 80),
 selection text NOT NULL CHECK(selection IN ('single','multiple')),
 instructions text NOT NULL CHECK(length(btrim(instructions)) <= 2000 AND (NOT enabled OR length(btrim(instructions)) > 0)),
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tag_groups_name_unique ON tag_groups(lower(name));
ALTER TABLE tags ADD COLUMN group_id uuid REFERENCES tag_groups(id);
ALTER TABLE tags ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE tags ADD COLUMN archived_at timestamptz;
DROP INDEX tags_name_unique;
CREATE UNIQUE INDEX tags_ungrouped_name_unique ON tags(lower(name)) WHERE group_id IS NULL AND archived_at IS NULL;
CREATE UNIQUE INDEX tags_group_name_unique ON tags(group_id,lower(name)) WHERE group_id IS NOT NULL AND archived_at IS NULL;

-- All assignment paths (manual, Jev, review) share the same group invariant.
CREATE FUNCTION enforce_tag_group() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g uuid; mode text;
BEGIN
 SELECT t.group_id,tg.selection INTO g,mode FROM tags t JOIN tag_groups tg ON tg.id=t.group_id WHERE t.id=NEW.tag_id;
 IF g IS NULL THEN RETURN NEW; END IF;
 PERFORM 1 FROM conversations WHERE mailbox_id=NEW.mailbox_id AND thread_id=NEW.thread_id FOR UPDATE;
 IF NEW.source='classifier' AND NEW.removed_at IS NULL AND EXISTS (
  SELECT 1 FROM conversation_tags ct JOIN tags t ON t.id=ct.tag_id
  WHERE ct.mailbox_id=NEW.mailbox_id AND ct.thread_id=NEW.thread_id AND t.group_id=g AND ct.source='manual'
 ) THEN RETURN NULL; END IF;
 IF mode='single' AND NEW.removed_at IS NULL THEN
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
CREATE TRIGGER conversation_tag_group BEFORE INSERT OR UPDATE ON conversation_tags
 FOR EACH ROW EXECUTE FUNCTION enforce_tag_group();

INSERT INTO tag_groups(name,selection,instructions) VALUES
 ('Urgency','single','Assess how soon action is needed. Low: no time-sensitive action. Medium: action needed soon, but it can wait until the next working day. High: delaying until tomorrow has meaningful consequences. Do not infer urgency solely from emphatic language.'),
 ('Importance','single','Assess customer and business impact independently of urgency. Low: routine or informational. Medium: affects a customer relationship or business process. High: significant customer, business or privacy consequences.'),
 ('Topic','multiple','Select every topic that describes the conversation. Billing: invoices, payments and charges. Privacy: personal data requests. Cancellation: ending a service. Partnership: proposals to work together.');
INSERT INTO tags(group_id,name,color,position)
 SELECT g.id,v.name,v.color,v.position FROM tag_groups g CROSS JOIN
 (VALUES('Low','#64748b',0),('Medium','#ca8a04',1),('High','#dc2626',2)) AS v(name,color,position)
 WHERE g.name IN ('Urgency','Importance');
INSERT INTO tags(group_id,name,color,position)
 SELECT g.id,v.name,'#2563eb',v.position FROM tag_groups g CROSS JOIN
 (VALUES('Billing',0),('Privacy',1),('Cancellation',2),('Partnership',3)) AS v(name,position)
 WHERE g.name='Topic';
INSERT INTO classifiers(tag_id,question)
 SELECT t.id,'Classify the conversation in the '||g.name||' group.'||E'\n'||g.instructions||E'\nAvailable tags: '||
 (SELECT string_agg(s.name,', ' ORDER BY s.position) FROM tags s WHERE s.group_id=g.id)||E'\n'||
 CASE WHEN g.selection='single' THEN 'Choose exactly one best-fitting tag; if evidence is insufficient, return uncertainty.' ELSE 'Several tags may apply independently.' END||
 E'\nShould '||t.name||' be selected in this group?'
 FROM tags t JOIN tag_groups g ON g.id=t.group_id;

CREATE FUNCTION tag_manually_overridden(m text,thread uuid,tag uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM conversation_tags ct JOIN tags selected ON selected.id=ct.tag_id JOIN tags target ON target.id=tag
  WHERE ct.mailbox_id=m AND ct.thread_id=thread AND ct.source='manual'
   AND (ct.tag_id=tag OR (target.group_id IS NOT NULL AND selected.group_id=target.group_id))
 );
$$;
