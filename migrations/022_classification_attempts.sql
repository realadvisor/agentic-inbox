-- Durable lifecycle records, including attempts that never reach the provider.
CREATE TABLE classification_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_token uuid NOT NULL,
 attempt integer NOT NULL,
 mailbox_id text NOT NULL,
 thread_id uuid NOT NULL,
 classifier_id uuid NOT NULL,
 classifier_name text NOT NULL,
 question text NOT NULL,
 subject text NOT NULL,
 revision integer NOT NULL,
 generation integer NOT NULL,
 started_at timestamptz NOT NULL,
 finished_at timestamptz,
 status text NOT NULL,
 answer boolean,
 probability double precision,
 error text,
 historical boolean NOT NULL DEFAULT false,
 UNIQUE(job_token,attempt),
 FOREIGN KEY(mailbox_id,thread_id) REFERENCES conversations(mailbox_id,thread_id) ON DELETE CASCADE
);
CREATE INDEX classification_attempts_page ON classification_attempts(started_at DESC,id DESC);
CREATE INDEX classifier_provider_items_job_attempt ON classifier_provider_run_items(job_token,attempt);
CREATE FUNCTION record_classification_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO classification_attempts(job_token,attempt,mailbox_id,thread_id,classifier_id,classifier_name,question,subject,revision,generation,started_at,finished_at,status,answer,probability,error)
 SELECT NEW.token,greatest(1,NEW.attempts),NEW.mailbox_id,NEW.thread_id,NEW.classifier_id,t.name,c.question,
 coalesce((SELECT subject FROM emails WHERE mailbox_id=NEW.mailbox_id AND thread_id=NEW.thread_id ORDER BY date DESC,id DESC LIMIT 1),'Conversation'),
 NEW.revision,NEW.generation,NEW.updated_at,CASE WHEN NEW.status<>'pending' OR (NEW.error IS NOT NULL AND NEW.lease_until IS NULL) THEN NEW.updated_at END,
 CASE WHEN NEW.status='pending' THEN CASE WHEN NEW.lease_until>now() THEN 'running' WHEN NEW.error IS NOT NULL THEN 'failed' ELSE 'queued' END
 WHEN NEW.status='complete' THEN 'succeeded' WHEN NEW.status='error' THEN 'failed'
 WHEN NEW.status='review' AND NEW.error IS NOT NULL THEN 'blocked' ELSE NEW.status END,
 NEW.answer,NEW.probability,NEW.error FROM classifiers c JOIN tags t ON t.id=c.tag_id WHERE c.id=NEW.classifier_id
 ON CONFLICT(job_token,attempt) DO UPDATE SET finished_at=excluded.finished_at,status=excluded.status,answer=excluded.answer,probability=excluded.probability,error=excluded.error;
 RETURN NULL;
END; $$;
CREATE TRIGGER classification_attempt_changed AFTER INSERT OR UPDATE ON conversation_classifications FOR EACH ROW EXECUTE FUNCTION record_classification_attempt();
-- Recover the known current state only; do not invent historical requests.
UPDATE conversation_classifications SET status=status;
UPDATE classification_attempts SET historical=true;
