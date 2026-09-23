ALTER TABLE conversations ADD COLUMN generation integer NOT NULL DEFAULT 0;
-- Explicit columns keep the existing registration trigger compatible.
CREATE OR REPLACE FUNCTION register_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO conversations(mailbox_id,thread_id) VALUES(NEW.mailbox_id,NEW.thread_id) ON CONFLICT DO NOTHING;
 RETURN NEW;
END; $$;
CREATE TABLE classifiers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tag_id uuid NOT NULL UNIQUE REFERENCES tags(id),
 question text NOT NULL CHECK(length(btrim(question)) BETWEEN 1 AND 4000),
 mailbox_ids text[] NOT NULL DEFAULT '{}',
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE classifier_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 classifier_id uuid NOT NULL REFERENCES classifiers(id),
 revision integer NOT NULL,
 actor text NOT NULL,
 status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX classifier_one_run ON classifier_runs(classifier_id) WHERE status='running';
CREATE TABLE classifier_run_items (
 run_id uuid NOT NULL REFERENCES classifier_runs(id) ON DELETE CASCADE,
 mailbox_id text NOT NULL,
 thread_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','review','failed','skipped')),
 PRIMARY KEY(run_id,mailbox_id,thread_id)
);
CREATE TABLE conversation_classifications (
 mailbox_id text NOT NULL,
 thread_id uuid NOT NULL,
 classifier_id uuid NOT NULL REFERENCES classifiers(id),
 revision integer NOT NULL,
 generation integer NOT NULL,
 token uuid NOT NULL DEFAULT gen_random_uuid(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','review','error','skipped')),
 answer boolean,
 probability double precision CHECK(probability BETWEEN 0 AND 1),
 source text NOT NULL DEFAULT 'jev' CHECK(source IN ('jev','human')),
 actor text,
 model text,
 error text,
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 run_id uuid REFERENCES classifier_runs(id),
 priority integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(mailbox_id,thread_id,classifier_id),
 FOREIGN KEY(mailbox_id,thread_id) REFERENCES conversations(mailbox_id,thread_id) ON DELETE CASCADE
);
CREATE INDEX classifier_jobs_ready ON conversation_classifications(available_at,priority) WHERE status='pending';
CREATE TABLE classifier_worker_slots (
 id integer PRIMARY KEY,
 token uuid,
 lease_until timestamptz,
 cooldown_until timestamptz
);
INSERT INTO classifier_worker_slots(id) VALUES(1),(2);
CREATE FUNCTION classifier_thread_active(m text,t uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM emails WHERE mailbox_id=m AND thread_id=t AND delivery_status='received' AND folder_id NOT IN ('archive','spam','trash'));
$$;
CREATE FUNCTION classifier_email_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m text; t uuid; g integer;
BEGIN
 IF TG_OP='DELETE' THEN m:=OLD.mailbox_id; t:=OLD.thread_id;
 ELSE m:=NEW.mailbox_id; t:=NEW.thread_id; END IF;
 IF TG_OP='INSERT' AND NEW.delivery_status NOT IN ('received','sent') THEN RETURN NULL; END IF;
 IF TG_OP='DELETE' AND OLD.delivery_status NOT IN ('received','sent') THEN RETURN NULL; END IF;
 IF TG_OP='UPDATE' THEN
  -- Moving between active folders does not invalidate a human correction.
  IF OLD.folder_id NOT IN ('archive','trash','spam') AND NEW.folder_id NOT IN ('archive','trash','spam')
   AND ROW(OLD.body,OLD.subject,OLD.sender,OLD.recipient,OLD.cc,OLD.delivery_status,OLD.date,OLD.thread_id,OLD.mailbox_id)
    IS NOT DISTINCT FROM ROW(NEW.body,NEW.subject,NEW.sender,NEW.recipient,NEW.cc,NEW.delivery_status,NEW.date,NEW.thread_id,NEW.mailbox_id) THEN RETURN NULL; END IF;
  IF OLD.delivery_status NOT IN ('received','sent') AND NEW.delivery_status NOT IN ('received','sent') THEN RETURN NULL; END IF;
  IF ROW(OLD.body,OLD.subject,OLD.sender,OLD.recipient,OLD.cc,OLD.delivery_status,OLD.folder_id,OLD.date,OLD.thread_id,OLD.mailbox_id)
    IS NOT DISTINCT FROM ROW(NEW.body,NEW.subject,NEW.sender,NEW.recipient,NEW.cc,NEW.delivery_status,NEW.folder_id,NEW.date,NEW.thread_id,NEW.mailbox_id) THEN RETURN NULL; END IF;
 END IF;
 UPDATE conversations SET generation=generation+1 WHERE mailbox_id=m AND thread_id=t RETURNING generation INTO g;
 IF g IS NULL THEN RETURN NULL; END IF;
 DELETE FROM conversation_tags ct USING classifiers c WHERE ct.tag_id=c.tag_id AND ct.source='classifier' AND ct.mailbox_id=m AND ct.thread_id=t;
 UPDATE conversation_classifications SET status='skipped',token=gen_random_uuid(),lease_until=NULL,updated_at=now() WHERE mailbox_id=m AND thread_id=t;
 IF classifier_thread_active(m,t) THEN
  INSERT INTO conversation_classifications(mailbox_id,thread_id,classifier_id,revision,generation)
   SELECT m,t,c.id,c.revision,g FROM classifiers c WHERE c.enabled AND (cardinality(c.mailbox_ids)=0 OR m=ANY(c.mailbox_ids))
  ON CONFLICT(mailbox_id,thread_id,classifier_id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,token=gen_random_uuid(),status='pending',answer=NULL,probability=NULL,source='jev',actor=NULL,model=NULL,error=NULL,attempts=0,available_at=now(),lease_until=NULL,priority=0,updated_at=now();
 ELSE
  UPDATE classifier_run_items i SET status='skipped' FROM conversation_classifications j WHERE j.mailbox_id=m AND j.thread_id=t AND i.run_id=j.run_id AND i.mailbox_id=m AND i.thread_id=t AND i.status='pending';
 END IF;
 RETURN NULL;
END; $$;
-- Runs after register_email_conversation; read/star updates do not enter this trigger.
CREATE TRIGGER zz_classifier_email_changed AFTER INSERT OR DELETE OR UPDATE OF body,subject,sender,recipient,cc,delivery_status,folder_id,date,thread_id,mailbox_id ON emails FOR EACH ROW EXECUTE FUNCTION classifier_email_changed();
INSERT INTO tags(name,color) VALUES('Needs reply','#ca8a04'),('Privacy: Deletion','#7c3aed'),('Privacy: Data access','#2563eb') ON CONFLICT DO NOTHING;
INSERT INTO classifiers(tag_id,question)
 SELECT id,CASE name
 WHEN 'Needs reply' THEN 'Does this conversation still need a reply from our mailbox? Consider actual sent replies; an acknowledgment alone may not answer the request.'
 WHEN 'Privacy: Deletion' THEN 'Does this conversation contain a request to delete personal data or an account, even if already answered?'
 ELSE 'Does this conversation contain a request for a copy of personal data, even if already answered?' END
 FROM tags WHERE name IN ('Needs reply','Privacy: Deletion','Privacy: Data access');
COMMENT ON TABLE conversation_classifications IS 'Durable Jev job and current result. Token fences retries, human corrections and new mail; manual tags remain authoritative.';
